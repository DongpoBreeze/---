import { resolve } from 'node:path';

const MICRO_CNY = 1_000_000;

export function currencyMicros(value, name = 'amount') {
  const input = String(value);
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input)) throw new Error(`Invalid ${name}`);
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * BigInt(MICRO_CNY) + BigInt(fraction.padEnd(6, '0'));
  if (amount > 1_000_000_000_000n) {
    throw new Error(`${name} is too large`);
  }
  return Number(amount);
}

function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function normalizeConfig(input) {
  const result = {
    host: input.host || '127.0.0.1',
    port: integer(input.port ?? 8787, 'PORT', 0, 65535),
    accessToken: input.accessToken || '',
    modelApiUrl: input.modelApiUrl || '',
    modelApiProtocol: input.modelApiProtocol ?? 'chat_completions',
    modelApiKey: input.modelApiKey || '',
    modelName: input.modelName || '',
    modelReasoningEffort: input.modelReasoningEffort ?? '',
    modelStream: input.modelStream ?? false,
    timeoutPerStage: true,
    monthlyBudgetCny: Number(input.monthlyBudgetCny ?? 300),
    fixedMonthlyCostCny: Number(input.fixedMonthlyCostCny ?? 0),
    nonAiMonthlyCostCny: Number(input.nonAiMonthlyCostCny ?? 0),
    safetyReserveCny: Number(input.safetyReserveCny ?? 30),
    maxRequestCostCny: Number(input.maxRequestCostCny ?? 1),
    dailyQuota: integer(input.dailyQuota ?? 10, 'INSTALLATION_DAILY_QUOTA', 1, 100_000),
    maxBodyBytes: integer(input.maxBodyBytes ?? 8 * 1024 * 1024, 'MAX_BODY_BYTES', 128, 64 * 1024 * 1024),
    maxPhotoBytes: integer(input.maxPhotoBytes ?? 3 * 1024 * 1024, 'MAX_PHOTO_BYTES', 64, 16 * 1024 * 1024),
    maxPhotos: integer(input.maxPhotos ?? 4, 'MAX_PHOTOS', 0, 4),
    maxPayloadTextBytes: integer(input.maxPayloadTextBytes ?? 32 * 1024, 'MAX_PAYLOAD_TEXT_BYTES', 128, 256 * 1024),
    maxOutputTokens: integer(input.maxOutputTokens ?? 8192, 'MODEL_MAX_OUTPUT_TOKENS', 32, 8192),
    // The product default is 120s. Keep the 180s ceiling for explicit diagnostics
    // of historically slow providers without making normal users wait that long.
    upstreamTimeoutMs: integer(input.upstreamTimeoutMs ?? 120_000, 'UPSTREAM_TIMEOUT_MS', 50, 180_000),
    bodyTimeoutMs: integer(input.bodyTimeoutMs ?? 10_000, 'BODY_TIMEOUT_MS', 50, 30_000),
    maxConcurrent: integer(input.maxConcurrent ?? 4, 'MAX_CONCURRENT_REQUESTS', 1, 1000),
    maxConcurrentPerInstallation: integer(input.maxConcurrentPerInstallation ?? 1, 'MAX_CONCURRENT_PER_INSTALLATION', 1, 100),
    resultCacheTtlMs: integer(input.resultCacheTtlMs ?? 600_000, 'RESULT_CACHE_TTL_MS', 50, 1_800_000),
    budgetTimezone: input.budgetTimezone || 'Asia/Shanghai',
    corsOrigins: input.corsOrigins ?? ['http://localhost:8081', 'http://127.0.0.1:8081', 'http://localhost:8082', 'http://127.0.0.1:8082'],
    dbPath: input.dbPath === ':memory:' ? ':memory:' : resolve(input.dbPath || 'server/health-compass.sqlite'),
    costCeilingConfigured: input.costCeilingConfigured ?? (input.maxRequestCostCny !== undefined && input.maxRequestCostCny !== ''),
  };
  if (!['chat_completions', 'responses'].includes(result.modelApiProtocol)) throw new Error('Invalid MODEL_API_PROTOCOL');
  if (typeof result.modelStream !== 'boolean' || (result.modelStream && result.modelApiProtocol !== 'responses')) {
    throw new Error('MODEL_STREAM requires the Responses protocol and a boolean value');
  }
  if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(result.modelReasoningEffort)) {
    throw new Error('Invalid MODEL_REASONING_EFFORT');
  }
  result.monthlyBudgetMicros = currencyMicros(input.monthlyBudgetCny ?? 300, 'MONTHLY_BUDGET_CNY');
  result.fixedMonthlyCostMicros = currencyMicros(input.fixedMonthlyCostCny ?? 0, 'FIXED_MONTHLY_COST_CNY');
  result.nonAiMonthlyCostMicros = currencyMicros(input.nonAiMonthlyCostCny ?? 0, 'NON_AI_MONTHLY_COST_CNY');
  result.safetyReserveMicros = currencyMicros(input.safetyReserveCny ?? 30, 'SAFETY_RESERVE_CNY');
  result.maxRequestCostMicros = currencyMicros(input.maxRequestCostCny ?? 1, 'MAX_REQUEST_COST_CNY');
  if (result.maxRequestCostMicros <= 0) throw new Error('MAX_REQUEST_COST_CNY must be positive');
  result.aiBudgetMicros = Math.max(0, result.monthlyBudgetMicros - result.fixedMonthlyCostMicros - result.nonAiMonthlyCostMicros - result.safetyReserveMicros);
  if (result.modelApiUrl) {
    let url;
    try { url = new URL(result.modelApiUrl); } catch { throw new Error('Invalid MODEL_API_URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('Invalid MODEL_API_URL');
    }
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      throw new Error('MODEL_API_URL must use HTTPS except for a loopback mock service');
    }
  }
  try { new Intl.DateTimeFormat('en', { timeZone: result.budgetTimezone }).format(new Date()); }
  catch { throw new Error('Invalid BUDGET_TIMEZONE'); }
  if (!Array.isArray(result.corsOrigins) || result.corsOrigins.some((origin) => {
    try { const url = new URL(origin); return url.origin !== origin || !['https:', 'http:'].includes(url.protocol); }
    catch { return true; }
  })) throw new Error('Invalid CORS_ORIGINS');
  for (const name of ['host', 'accessToken', 'modelApiKey', 'modelName']) {
    if (typeof result[name] !== 'string' || result[name].includes('\n') || result[name].includes('\r')) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (result.accessToken.length > 4096 || result.modelApiKey.length > 4096 || result.modelName.length > 200) {
    throw new Error('Credential or model setting is too long');
  }
  return result;
}

export function parseConfig(env = process.env) {
  if (env.MODEL_STREAM !== undefined && !['true', 'false'].includes(env.MODEL_STREAM)) throw new Error('Invalid MODEL_STREAM');
  const modelApiProtocol = env.MODEL_API_PROTOCOL ?? 'chat_completions';
  let modelApiUrl = env.MODEL_API_URL || '';
  if (!modelApiUrl && env.MODEL_BASE_URL) {
    let base;
    try { base = new URL(env.MODEL_BASE_URL); } catch { throw new Error('Invalid MODEL_BASE_URL'); }
    const endpoint = modelApiProtocol === 'responses' ? '/responses' : '/chat/completions';
    const path = base.pathname.replace(/\/+$/, '');
    base.pathname = path.endsWith(endpoint) ? path : `${path}${endpoint}`;
    modelApiUrl = base.href;
  }
  return normalizeConfig({
    host: env.HOST,
    port: env.PORT,
    accessToken: env.SERVER_ACCESS_TOKEN,
    modelApiUrl,
    modelApiProtocol,
    modelApiKey: env.MODEL_API_KEY || env.MODEL_API_TOKEN,
    modelName: env.MODEL_NAME || env.MODEL_MODEL,
    modelReasoningEffort: env.MODEL_REASONING_EFFORT,
    modelStream: env.MODEL_STREAM === 'true',
    monthlyBudgetCny: env.MONTHLY_BUDGET_CNY,
    fixedMonthlyCostCny: env.FIXED_MONTHLY_COST_CNY,
    nonAiMonthlyCostCny: env.NON_AI_MONTHLY_COST_CNY,
    safetyReserveCny: env.SAFETY_RESERVE_CNY,
    maxRequestCostCny: env.MAX_REQUEST_COST_CNY || undefined,
    dailyQuota: env.INSTALLATION_DAILY_QUOTA,
    maxBodyBytes: env.MAX_BODY_BYTES,
    maxPhotoBytes: env.MAX_PHOTO_BYTES,
    maxPhotos: env.MAX_PHOTOS,
    maxPayloadTextBytes: env.MAX_PAYLOAD_TEXT_BYTES,
    maxOutputTokens: env.MODEL_MAX_OUTPUT_TOKENS,
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
    bodyTimeoutMs: env.BODY_TIMEOUT_MS,
    maxConcurrent: env.MAX_CONCURRENT_REQUESTS,
    maxConcurrentPerInstallation: env.MAX_CONCURRENT_PER_INSTALLATION,
    resultCacheTtlMs: env.RESULT_CACHE_TTL_MS,
    budgetTimezone: env.BUDGET_TIMEZONE,
    corsOrigins: env.CORS_ORIGINS === undefined ? undefined : env.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
    dbPath: env.HEALTH_DB_PATH,
    costCeilingConfigured: env.MAX_REQUEST_COST_CNY !== undefined && env.MAX_REQUEST_COST_CNY !== '',
  });
}

export function isConfigured(config) {
  return Boolean(config.accessToken && config.modelApiUrl && config.modelApiKey && config.modelName && config.costCeilingConfigured);
}
