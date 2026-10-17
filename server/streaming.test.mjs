import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAppServer } from './index.mjs';
import { normalizeConfig, parseConfig } from './config.mjs';

const recognition = { foodName: '米饭与未知配料', components: [
  { foodId: 'rice_white_long_grain_cooked', label: '熟米饭', uncertainty: ['份量未知'], confidence: 0.8,
    category: 'grain', candidates: [], evidence: [], region: null },
], unresolved: ['份量未知'], assumptions: [], advice: '请补充实际记录。', confidence: 0.8 };
const completed = (content = recognition) => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(content) }] },
] });
const event = (value) => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(run, timeoutMs = 2_000) {
  let handler = (response) => response.end(event({ type: 'response.completed', response: completed() }));
  const calls = [];
  const events = [];
  const diagnostics = [];
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    handler(response);
  });
  let gateway;
  try {
    const upstreamUrl = await listen(upstream);
    gateway = createAppServer({ config: {
      dbPath: ':memory:', port: 0, accessToken: 'mock-client', modelApiKey: 'mock-key',
      modelApiUrl: `${upstreamUrl}/v1/responses`, modelApiProtocol: 'responses', modelStream: true,
      modelName: 'gpt-6.1-sol', modelReasoningEffort: 'max', maxRequestCostCny: 1,
      monthlyBudgetCny: 100, safetyReserveCny: 0, dailyQuota: 100, upstreamTimeoutMs: timeoutMs,
    }, onUpstreamEvent: (value) => events.push(value), onUpstreamError: (value) => diagnostics.push(value) });
    const url = await listen(gateway.server);
    const api = async (id) => {
      const response = await fetch(`${url}/api/analyze`, { method: 'POST',
        headers: { Authorization: 'Bearer mock-client', 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: id, installationId: 'stream-test', kind: 'meal', payload: {} }),
      });
      return { status: response.status, body: await response.json() };
    };
    await run({ api, calls, events, diagnostics, gateway, setHandler: (value) => { handler = value; } });
  } finally {
    for (const server of [gateway?.server, upstream]) if (server?.listening) {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }
}

test('streaming is explicit and restricted to Responses', () => {
  assert.equal(normalizeConfig({}).modelStream, false);
  assert.equal(parseConfig({ MODEL_API_PROTOCOL: 'responses', MODEL_STREAM: 'true' }).modelStream, true);
  assert.throws(() => parseConfig({ MODEL_STREAM: '1' }), /MODEL_STREAM/);
  assert.throws(() => normalizeConfig({ modelApiProtocol: 'responses', modelStream: 'true' }), /MODEL_STREAM/);
  assert.throws(() => normalizeConfig({ modelStream: true }), /MODEL_STREAM/);
});

test('split SSE and UTF-8 produce one complete analysis; diagnostics contain no provisional text', async () => {
  await fixture(async ({ api, calls, events, setHandler }) => {
    setHandler((response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const data = Buffer.from(': keepalive\r\n\r\n' + event({ type: 'response.created', response: { status: 'in_progress' } })
        + event({ type: 'response.output_text.delta', delta: 'PRIVATE_TEST_TEXT_73 不应被保存' })
        + event({ type: 'response.completed', response: completed() }));
      for (let offset = 0; offset < data.length; offset += 7) response.write(data.subarray(offset, offset + 7));
      response.end();
    });
    const result = await api('good');
    assert.equal(result.status, 200);
    assert.equal(result.body.analysis.status, 'unknown');
    assert.equal(result.body.analysis.components[0].label, '熟米饭');
    assert.equal(result.body.analysis.calories, null);
    assert.equal(calls[0].stream, true);
    assert.deepEqual(calls[0].reasoning, { effort: 'max' });
    assert.equal(calls[0].model, 'gpt-6.1-sol');
    assert.equal(events.some((item) => item.type === 'response.completed'), true);
    assert.equal(events.every((item) => Number.isInteger(item.elapsedMs)), true);
    assert.equal(JSON.stringify(events).includes('PRIVATE_TEST_TEXT_73'), false);
    assert.deepEqual(await api('good'), result);
    assert.equal(calls.length, 1);
  });
});

test('partial output, stream failures and invalid completion never become saved analyses', async () => {
  await fixture(async ({ api, calls, gateway, setHandler }) => {
    const bad = [
      event({ type: 'response.output_text.delta', delta: JSON.stringify(recognition) }) + 'data: [DONE]\n\n',
      event({ type: 'response.failed', response: { status: 'failed' }, error: { message: 'PRIVATE_TEST_TEXT_73' } }),
      event({ type: 'response.incomplete', response: { status: 'incomplete' } }),
      event({ type: 'error', message: 'PRIVATE_TEST_TEXT_73' }),
      event({ type: 'response.completed', response: { ...completed(), status: 'incomplete' } }),
      event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name: 'unexpected' }] } }),
      event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] } }),
      event({ type: 'response.completed', response: completed({ status: 'unknown' }) }),
      'event: response.created\ndata: {"type":"response.completed"}\n\n',
      'data: invalid JSON\n\n',
      event({ type: 'response.completed', response: completed() }).trimEnd(),
    ];
    for (const [index, body] of bad.entries()) {
      setHandler((response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(body); });
      const result = await api(`bad-${index}`);
      assert.equal(result.status, 502, `case ${index}`);
      assert.equal(result.body.error.code, [1, 3].includes(index) ? 'upstream_unavailable' : 'invalid_model_response');
      assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_TEXT_73'), false);
      assert.equal((await api(`bad-${index}`)).status, 502);
    }
    assert.equal(calls.length, bad.length);
    assert.equal(gateway.ledger.db.prepare("SELECT COUNT(*) AS n FROM request_ledger WHERE status='failed' AND cost_micros=1000000").get().n, bad.length);
  });
});

test('stream failure details are safely classified without leaking provider text or partial output', async () => {
  await fixture(async ({ api, diagnostics, setHandler }) => {
    setHandler((response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(event({ type: 'response.output_text.delta', delta: 'PRIVATE_TEST_TEXT_73' })
        + event({ type: 'response.failed', response: { status: 'failed', error: {
          code: 'server_error', message: 'Internal server error PRIVATE_TEST_TEXT_73',
        } } }));
    });
    const result = await api('internal-failure');
    assert.equal(result.body.error.code, 'upstream_unavailable');
    assert.deepEqual(diagnostics, [{ status: 200, category: 'upstream_server_error', fieldHints: [] }]);
    assert.equal(JSON.stringify({ result, diagnostics }).includes('PRIVATE_TEST_TEXT_73'), false);
    setHandler((response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(event({ type: 'response.incomplete', response: {
        status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      } }));
    });
    assert.equal((await api('limit')).body.error.code, 'invalid_model_response');
    assert.deepEqual(diagnostics[1], { status: 200, category: 'output_limit', fieldHints: [] });
  });
});

test('stream content type and event buffer are bounded', async () => {
  await fixture(async ({ api, setHandler }) => {
    setHandler((response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(completed())); });
    assert.equal((await api('json-in-stream')).body.error.code, 'invalid_model_response');
    setHandler((response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: ' + 'x'.repeat(140 * 1024)); });
    assert.equal((await api('large-event')).body.error.code, 'invalid_model_response');
    setHandler((response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(': heartbeat\n\n'.repeat(200_000)); });
    assert.equal((await api('large-stream')).body.error.code, 'invalid_model_response');
  });
});

test('upstream timeout remains bounded after receiving SSE headers and heartbeats', async () => {
  await fixture(async ({ api, events, gateway, setHandler }) => {
    setHandler((response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': heartbeat\n\n');
    });
    const result = await api('timeout');
    assert.equal(result.status, 504);
    assert.equal(result.body.error.code, 'upstream_timeout');
    assert.equal(events.find((item) => item.phase === 'headers')?.format, 'sse');
    assert.equal(events.filter((item) => item.phase === 'stage').length, 1);
    assert.equal(gateway.ledger.db.prepare('SELECT cost_micros FROM request_ledger').get().cost_micros, 1_000_000);
  }, 150);
});

test('upstream 524 is safely distinguished from image format rejection', async () => {
  await fixture(async ({ api, diagnostics, setHandler }) => {
    setHandler((response) => { response.writeHead(524, { 'Content-Type': 'text/html' }); response.end('<html>PRIVATE_TEST_TEXT_73</html>'); });
    const result = await api('524');
    assert.equal(result.status, 502);
    assert.deepEqual(diagnostics, [{ status: 524, category: 'upstream_gateway_timeout', fieldHints: [] }]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TEST_TEXT_73'), false);
  });
});
