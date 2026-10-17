import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { BudgetLedger } from './ledger.mjs';
import { GatewayError, callModel, readBody, validateRequest, normaliseAnalysis } from './protocol.mjs';
import { isConfigured, normalizeConfig, parseConfig } from './config.mjs';

function authMatches(request, config) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer\s+\S+$/i.test(value)) return false;
  const provided = Buffer.from(value.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(config.accessToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function corsHeaders(request, config) {
  const origin = request.headers.origin;
  const headers = {
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (origin && config.corsOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function sendJson(request, response, config, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(request, config),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

function sendError(request, response, config, error) {
  const status = error instanceof GatewayError ? error.status : 500;
  const code = error instanceof GatewayError ? error.code : 'internal_error';
  const message = error instanceof GatewayError ? error.message : '服务暂时不可用。';
  sendJson(request, response, config, status, { error: { code, message } });
}

function safeHealth(config, ledger) {
  const configured = isConfigured(config);
  return {
    configured,
    limits: {
      monthlyBudgetCny: config.monthlyBudgetCny,
      installationDailyQuota: config.dailyQuota,
      maxRequestCostCny: config.maxRequestCostCny,
      aiBudgetCny: config.aiBudgetMicros / 1_000_000,
    },
    storage: ledger ? 'ready' : 'unavailable',
  };
}

export function createAppServer(options = {}) {
  const config = options.config ? normalizeConfig(options.config) : parseConfig(options.env || process.env);
  const ledger = options.ledger || new BudgetLedger(config.dbPath);
  const results = new Map();
  function resultKey(input) { return JSON.stringify([input.installationId, input.requestId]); }
  function removeResult(key) {
    const item = results.get(key);
    if (item) clearTimeout(item.timer);
    results.delete(key);
  }
  function cacheResult(input, result) {
    const now = Date.now();
    for (const [key, item] of results) if (item.expiresAt <= now) removeResult(key);
    if (results.size >= 256) removeResult(results.keys().next().value);
    const key = resultKey(input);
    const timer = setTimeout(() => results.delete(key), config.resultCacheTtlMs);
    timer.unref();
    results.set(key, { result, expiresAt: now + config.resultCacheTtlMs, timer });
  }
  const server = createServer(async (request, response) => {
    const clientAbort = new AbortController();
    request.once('aborted', () => clientAbort.abort());
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders(request, config));
        response.end();
        return;
      }
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(request, response, config, 200, safeHealth(config, ledger));
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/api/analyze') {
        sendError(request, response, config, new GatewayError(404, 'not_found', '请求路径不存在。'));
        return;
      }
      if (!isConfigured(config)) {
        sendError(request, response, config, new GatewayError(503, 'server_not_configured', '分析服务尚未配置。'));
        request.resume();
        return;
      }
      if (!authMatches(request, config)) {
        sendError(request, response, config, new GatewayError(401, 'unauthorized', '需要有效的访问令牌。'));
        request.resume();
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        request.resume();
        throw new GatewayError(415, 'unsupported_media_type', '请求需使用 application/json。');
      }
      const body = await readBody(request, config);
      let input;
      try { input = JSON.parse(body); } catch { throw new GatewayError(400, 'invalid_json', '请求不是有效 JSON。'); }
      validateRequest(input, config);

      const reservation = ledger.reserve(input, config);
      if (reservation.status === 'replay') {
        if (reservation.entry.status === 'completed') {
          const cached = results.get(resultKey(input));
          if (cached && cached.expiresAt > Date.now()) sendJson(request, response, config, 200, cached.result);
          else {
            removeResult(resultKey(input));
            sendError(request, response, config, new GatewayError(410, 'result_expired', '该请求已完成，临时结果已清除，不会再次调用模型。'));
          }
        } else if (reservation.entry.status === 'reserved') {
          sendError(request, response, config, new GatewayError(409, 'request_in_progress', '相同请求正在处理，请稍后重试。', true));
        } else {
          sendError(request, response, config, new GatewayError(reservation.entry.http_status || 502, reservation.entry.error_code || 'upstream_unavailable', '该请求已结束，可能已产生费用；不会重复调用模型。'));
        }
        return;
      }
      if (reservation.status === 'conflict') throw new GatewayError(409, 'request_id_conflict', '请求 ID 已被其他内容使用。');
      if (reservation.status === 'monthly_limit') throw new GatewayError(429, 'monthly_budget_exhausted', '本月分析额度已用完。');
      if (reservation.status === 'daily_limit') throw new GatewayError(429, 'daily_quota_exhausted', '本安装今日分析额度已用完。');
      if (reservation.status === 'concurrent_limit') throw new GatewayError(429, 'concurrency_limit', '分析请求正在处理，请稍后重试。', true);

      try {
        const modelResult = await callModel(input, config, clientAbort.signal, options.onUpstreamError, options.onUpstreamEvent,
          options.onBeforeUpstreamRequest, options.onUpstreamAttemptResult, options.onRawUpstreamResponse, options.createCrops);
        const result = { analysis: modelResult.analysis, model: config.modelName, createdAt: new Date().toISOString(), stageCount: modelResult.stageCount };
        const finished = ledger.finish(input, 200, null);
        if (!finished) throw new GatewayError(500, 'ledger_settlement_failed', '分析已完成但无法安全记录额度。');
        if (!clientAbort.signal.aborted) {
          cacheResult(input, result);
          sendJson(request, response, config, 200, result);
        }
      } catch (error) {
        // Once sent upstream, reserve the full worst-case amount even if the client sees an error.
        ledger.finish(input, error instanceof GatewayError ? error.status : 502, error instanceof GatewayError ? error.code : 'upstream_unavailable');
        sendError(request, response, config, error);
      }
    } catch (error) {
      if (!response.headersSent) sendError(request, response, config, error);
      else response.destroy();
    }
  });
  server.on('close', () => {
    for (const key of results.keys()) removeResult(key);
    if (!options.ledger) ledger.close();
  });
  return { server, ledger, config };
}

export { parseConfig, normaliseAnalysis };

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const runtime = createAppServer();
    runtime.server.listen(runtime.config.port, runtime.config.host, () => {
      console.log(`Health Compass analysis gateway listening on http://${runtime.config.host}:${runtime.config.port}`);
      if (!isConfigured(runtime.config)) console.log('Analysis gateway is not configured; /api/analyze returns 503 until model and token settings are provided.');
    });
  } catch (error) {
    console.error(`Health Compass server configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}
