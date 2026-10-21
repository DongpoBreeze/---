import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestProvider } from '../src/ai-provider.ts';
import { RealMealTestLedger } from './real-meal-test-ledger.mjs';
import { RawStreamCapture, safeUsage, redactSecrets, redactValue, credentialForms, runObservedMealTask, assertArtifactsHaveNoSecret } from './meal-latency-capture.mjs';
import { chooseFinalist, summarizeProfile, buildLatencyReport, createLatencyReveal, normalizeQuality } from './meal-latency-core.mjs';
import { fixtureManifest, fakeProvider, recognition, completedEnvelope, sse, injectedProvider, withTemporaryDirectory, acceptedRecord, assessment } from './meal-latency-test-helpers.mjs';

const photo = 'data:image/jpeg;base64,/9j/';
const settings = { ...fakeProvider, model: 'gpt-6.1-sol', reasoningEffort: 'max' };
const ledgerOptions = { limits: { totalRequests: 22, perMealRequests: 1, reviewMeals: 0, cohortMeals: 10 }, allowProviderOverride: true };

test('same-reader capture timestamps only actual nonempty text, preserves split UTF-8/secrets, and flattens reported nested usage', async () => {
  await withTemporaryDirectory(async (directory) => {
    let time = 1000;
    const capture = new RawStreamCapture({ key: fakeProvider.key, clock: () => time });
    time = 1010; capture.observe({ type: 'headers', httpStatus: 200 });
    time = 1020; capture.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.created' })) });
    time = 1030; capture.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.output_text.delta', delta: '' })) });
    assert.equal(capture.timing.firstTextDeltaMs, null);
    time = 7010;
    const content = Buffer.from(sse({ type: 'response.output_text.delta', delta: `中文 ${fakeProvider.key} Bearer other-private-token` }));
    const split = content.indexOf(Buffer.from(fakeProvider.key)) + 7;
    capture.observe({ type: 'chunk', bytes: content.subarray(0, split) });
    capture.observe({ type: 'chunk', bytes: content.subarray(split) });
    time = 7020; capture.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.completed', response: { usage: {
      input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 30 }, secret: 'discard',
    } } })) });
    capture.observe({ type: 'transport_complete' });
    assert.equal(await capture.save(directory, 'raw.sse'), 'saved');
    const raw = await readFile(join(directory, 'raw.sse'), 'utf8');
    assert.match(raw, /中文/); assert.ok(!raw.includes(fakeProvider.key)); assert.ok(!raw.includes('other-private-token'));
    assert.equal(capture.timing.headersMs, 10); assert.equal(capture.timing.firstEventMs, 20);
    assert.equal(capture.timing.firstTextDeltaMs, 6010); assert.equal(capture.timing.responseCompletedMs, 6020);
    assert.deepEqual(capture.usage, { input_tokens: 100, output_tokens: 50, total_tokens: 150, cached_input_tokens: 40, reasoning_tokens: 30 });
    await assertArtifactsHaveNoSecret(directory, fakeProvider.key);
  });
});

test('capture is bounded, redacts a credential split at the truncation boundary, and distinguishes empty from save failure', async () => {
  await withTemporaryDirectory(async (directory) => {
    const prefix = `data: ${fakeProvider.key}`;
    const capture = new RawStreamCapture({ key: fakeProvider.key, maxBytes: 15 });
    capture.observe({ type: 'chunk', bytes: Buffer.from(prefix) });
    assert.equal(await capture.save(directory, 'truncated.sse'), 'truncated');
    assert.equal(capture.capturedBytes, 15); assert.equal(capture.observedBytes, Buffer.byteLength(prefix));
    assert.match(await readFile(join(directory, 'truncated.sse'), 'utf8'), /REDACTED_TRUNCATED_CREDENTIAL/);
    const empty = new RawStreamCapture(); assert.equal(await empty.save(directory, 'empty.sse'), 'empty');
    assert.equal((await readFile(join(directory, 'empty.sse'))).length, 0);
    const failed = new RawStreamCapture(); failed.observe({ type: 'chunk', bytes: Buffer.from('prefix') });
    assert.equal(await failed.save(directory, 'unwritten.sse', async () => { throw new Error('offline write failure'); }), 'save_failed');
    assert.equal(failed.rawArtifact, null);
    const invalidUtf8 = new RawStreamCapture(); const rawBytes = Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xe4]);
    invalidUtf8.observe({ type: 'chunk', bytes: rawBytes }); await invalidUtf8.save(directory, 'invalid-utf8.sse');
    assert.deepEqual(await readFile(join(directory, 'invalid-utf8.sse')), rawBytes);
    assert.deepEqual(safeUsage({ input_tokens: -1, output_tokens: 2.5, total_tokens: '3', output_tokens_details: { reasoning_tokens: 2 } }), { reasoning_tokens: 2 });
    assert.equal(redactSecrets('Bearer token split later', 'different-key'), 'Bearer [REDACTED] split later');
  });
});

test('first response text also timestamps output_text.done and completed assistant text while excluding reasoning', () => {
  let time = 0;
  const done = new RawStreamCapture({ clock: () => time });
  time = 10; done.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.reasoning_summary_text.delta', delta: 'reasoning only' })) });
  assert.equal(done.timing.firstTextMs, null);
  time = 20; done.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.output_text.done', text: 'actual response body' })) });
  assert.equal(done.timing.firstTextMs, 20); assert.equal(done.timing.firstTextDeltaMs, null);
  time = 30;
  const complete = new RawStreamCapture({ clock: () => time });
  time = 45; complete.observe({ type: 'chunk', bytes: Buffer.from(sse({ type: 'response.completed', response: completedEnvelope(recognition()) })) });
  assert.equal(complete.timing.firstTextMs, 15); assert.equal(complete.timing.firstTextDeltaMs, null);
  assert.equal(complete.timing.responseCompletedMs, 15);
});

test('actual HTTP errors archive bounded observed body bytes with split secrets and retain their HTTP failure classification', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const task = fixtureManifest().pilotSchedule[0];
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      sends += 1;
      const text = Buffer.from(`upstream error prefix Bearer ${fakeProvider.key} end`);
      const split = text.indexOf(Buffer.from(fakeProvider.key)) + 4;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(text.subarray(0, split)); controller.enqueue(text.subarray(split)); controller.close();
      } }), { status: 429, headers: { 'Content-Type': 'text/plain' } });
    });
    try {
      const result = await runObservedMealTask({ task, ledger, provider: settings, photo, artifactDir: directory, requestProvider });
      assert.equal(sends, 1); assert.equal(result.transportCompleted, false); assert.equal(result.businessAccepted, false);
      assert.equal(result.stages[0].httpStatus, 429); assert.equal(result.stages[0].captureStatus, 'saved');
      assert.equal(result.error.code, 'rate_or_quota_limit');
      const raw = await readFile(join(directory, result.stages[0].rawArtifact), 'utf8');
      assert.match(raw, /upstream error prefix/); assert.ok(!raw.includes(fakeProvider.key));
      assert.equal(result.stages[0].capture.httpErrorMaxBytes, 65536); assert.equal(result.stages[0].capture.httpErrorReadWindowMs, 50);
      await assertArtifactsHaveNoSecret(directory, fakeProvider.key);
    } finally { ledger.close(); }
  });
});

test('mandatory reservation failure produces zero sends and cannot be swallowed as an observational callback', async () => {
  await withTemporaryDirectory(async (directory) => {
    const calls = [];
    const ledger = { reserve() { throw new Error('ledger cannot persist'); }, finish() { throw new Error('should not finish'); } };
    const task = fixtureManifest().pilotSchedule[0];
    const result = await runObservedMealTask({ task, ledger, provider: settings, photo, artifactDir: directory, requestProvider: injectedProvider({ calls }) });
    assert.equal(calls.length, 0); assert.equal(result.stages.length, 0); assert.equal(result.status, 'not_sent');
    assert.equal(result.fatalPersistenceError, 'request_reservation_failed');
  });
});

test('escaped printable credentials are removed from raw/error/analysis/result exports and detected by the artifact check', async () => {
  await withTemporaryDirectory(async (directory) => {
    const key = 'offline\\credential"suffix';
    const model = recognition(); model.components[0].evidence = [key, JSON.stringify({ nested: key })];
    const provider = { ...settings, key };
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    try {
      const task = fixtureManifest().pilotSchedule[0];
      const result = await runObservedMealTask({ task, ledger, provider, photo, artifactDir: directory,
        requestProvider: injectedProvider({ result: model }) });
      const exported = JSON.stringify(result);
      assert.ok(!credentialForms(key).some((form) => exported.includes(form)));
      assert.notEqual(result.analysis.components[0].evidence[0], key);
      await writeFile(join(directory, 'export.json'), exported);
      const original = { message: key, nested: JSON.stringify({ key }) };
      const redacted = JSON.parse(JSON.stringify(redactValue(original, key)));
      assert.ok(redacted.message.includes('REDACTED')); assert.ok(!redacted.nested.includes(key));
      const failed = await runObservedMealTask({ task: { ...task, mealId: 'escaped-error', validationRunId: 'escaped-error' }, ledger,
        provider, photo, artifactDir: directory, requestProvider: async (_s, _k, _p, _signal, options) => {
          const stage = { stage: 'whole', stageCount: 1 }; await options.beforeRequest(stage);
          options.onTransport({ ...stage, type: 'headers', httpStatus: 200 });
          const error = new Error(`Failure containing ${key}`); error.code = 'invalid_response'; throw error;
        } });
      assert.ok(!failed.error.message.includes(key));
      await writeFile(join(directory, 'failed.json'), JSON.stringify(failed));
      await assertArtifactsHaveNoSecret(directory, key);
      await writeFile(join(directory, 'unsafe.json'), JSON.stringify({ key }));
      await assert.rejects(assertArtifactsHaveNoSecret(directory, key), /Credential found/);
      await unlink(join(directory, 'unsafe.json'));
    } finally { ledger.close(); }
  });
});

test('every captured prefix redacts a trailing partial credential, including the upstream 64KiB boundary and escaped forms', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const key = 'thirty-characters-private-key!!';
    const body = `${'x'.repeat(65536 - key.length + 1)}${key} more error bytes`;
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    try {
      const result = await runObservedMealTask({ task: fixtureManifest().pilotSchedule[0], ledger, provider: { ...settings, key },
        photo, artifactDir: directory, requestProvider });
      const stage = result.stages[0], raw = await readFile(join(directory, stage.rawArtifact), 'utf8');
      assert.equal(stage.capture.observedBytes, 65536); assert.equal(stage.capture.truncated, false);
      assert.ok(!raw.includes(key.slice(0, -1))); assert.match(raw, /REDACTED_TRUNCATED_CREDENTIAL/);
      const escaped = 'offline\\credential"suffix';
      const form = JSON.stringify(escaped).slice(1, -1);
      const capture = new RawStreamCapture({ key: escaped });
      capture.observe({ type: 'chunk', bytes: Buffer.from(`error-prefix ${form.slice(0, -2)}`) });
      await capture.save(directory, 'escaped-prefix.sse');
      const text = await readFile(join(directory, 'escaped-prefix.sse'), 'utf8');
      assert.ok(!text.includes(form.slice(0, -2))); assert.match(text, /REDACTED_TRUNCATED_CREDENTIAL/);
    } finally { ledger.close(); }
  });
});

test('actual provider keeps no completion, invalid JSON, and business rejection independent, with raw prefixes and reported usage', async (t) => {
  await withTemporaryDirectory(async (directory) => {
    const cases = [
      { id: 'no-completion', wire: sse({ type: 'response.output_text.delta', delta: JSON.stringify(recognition()) }), completed: false },
      { id: 'invalid-json', wire: sse({ type: 'response.completed', response: completedEnvelope('{') }), completed: true },
      { id: 'business-rejection', wire: sse({ type: 'response.completed', response: completedEnvelope({}, { output_tokens: 21, output_tokens_details: { reasoning_tokens: 13 } }) }), completed: true },
    ];
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    let fetches = 0;
    try {
      for (const entry of cases) {
        t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return new Response(entry.wire, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); });
        const task = { ...fixtureManifest().pilotSchedule[0], validationRunId: entry.id, mealId: entry.id };
        const result = await runObservedMealTask({ task, ledger, provider: settings, photo, artifactDir: directory, requestProvider });
        assert.equal(result.transportCompleted, entry.completed, entry.id); assert.equal(result.businessAccepted, false, entry.id);
        assert.equal(result.stages[0].businessAccepted, false); assert.equal(result.stages[0].captureStatus, 'saved');
        assert.equal(result.stages[0].analysis, null); assert.equal(result.error.code, 'invalid_response');
        assert.equal(await readFile(join(directory, result.stages[0].rawArtifact), 'utf8'), entry.wire);
        const row = ledger.attemptsForRun(entry.id)[0];
        assert.equal(row.providerCompleted, entry.completed); assert.equal(row.resultAccepted, false);
        if (entry.id === 'business-rejection') assert.deepEqual(row.usage, { output_tokens: 21, reasoning_tokens: 13 });
        t.mock.restoreAll();
      }
      assert.equal(fetches, 3);
    } finally { ledger.close(); }
  });
});

test('a failed stream retains real prefix arriving beyond five seconds without a clone snapshot', { timeout: 10000 }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    const task = fixtureManifest().pilotSchedule[0];
    const provider = async (_settings, _kind, _payload, _signal, options) => {
      const stage = { stage: 'whole', stageCount: 1 };
      await options.beforeRequest(stage);
      options.onTransport({ ...stage, type: 'headers', httpStatus: 200 });
      options.onTransport({ ...stage, type: 'chunk', bytes: Buffer.from('data: {"type":"response.created"}\n\n') });
      await delay(5200);
      options.onTransport({ ...stage, type: 'chunk', bytes: Buffer.from(`data: late-prefix ${fakeProvider.key}\n`) });
      options.onDiagnostic({ ...stage, type: 'stage_error', code: 'timeout', transportCompleted: false, httpStatus: 200 });
      const error = new Error('offline timeout'); error.code = 'timeout'; throw error;
    };
    try {
      const result = await runObservedMealTask({ task, ledger, provider: settings, photo, artifactDir: directory, requestProvider: provider });
      const raw = await readFile(join(directory, result.stages[0].rawArtifact), 'utf8');
      assert.match(raw, /late-prefix/); assert.ok(!raw.includes(fakeProvider.key));
      assert.equal(result.status, 'timeout'); assert.equal(result.transportCompleted, false); assert.ok(result.elapsedMs >= 5200);
      assert.equal(result.stages[0].captureStatus, 'saved'); await assertArtifactsHaveNoSecret(directory, fakeProvider.key);
    } finally { ledger.close(); }
  });
});

test('archive or ledger persistence failure remains fatal even if the provider returned an accepted analysis', async () => {
  await withTemporaryDirectory(async (directory) => {
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    try {
      const result = await runObservedMealTask({ task: fixtureManifest().pilotSchedule[0], ledger, provider: settings, photo, artifactDir: directory,
        requestProvider: injectedProvider(), write: async (path, value, options) => {
          if (path.endsWith('.sse')) throw new Error('offline archive failure');
          return writeFile(path, value, options);
        } });
      assert.equal(result.businessAccepted, true); assert.equal(result.stages[0].captureStatus, 'save_failed');
      assert.equal(result.fatalPersistenceError, 'raw_archive_write_failed');
      assert.equal(ledger.attempts()[0].providerCompleted, true);
    } finally { ledger.close(); }
  });
});

test('slow local archive writes cannot change returned latency, finalist ranking or the 45-second acceptance threshold', async () => {
  await withTemporaryDirectory(async (directory) => {
    let time = 0;
    const manifest = fixtureManifest(), task = manifest.pilotSchedule[0];
    const ledger = new RealMealTestLedger(join(directory, 'ledger.sqlite'), ledgerOptions);
    try {
      const result = await runObservedMealTask({ task, ledger, provider: settings, photo, artifactDir: directory, clock: () => time,
        requestProvider: injectedProvider({ clockStep: (delta) => { time += delta; } }),
        write: async (path, value, config) => { time += 30000; return writeFile(path, value, config); } });
      assert.equal(result.stages[0].timing.returnedMs, 60);
      assert.equal(result.elapsedMs, 60); assert.equal(result.timing.returnedMs, 60);
      assert.equal(result.archiveElapsedMs, 60000); assert.equal(result.runnerElapsedMs, 60060);
      const archived = JSON.parse(await readFile(join(directory, result.stages[0].stageArtifact), 'utf8'));
      assert.equal(archived.taskElapsedMs, 60);
      assert.equal(summarizeProfile([result], 1).latencyMs.median, 60);
      const pilot = manifest.pilotSchedule.map((row) => row.profile === 'A' ? { ...result, ...row } : acceptedRecord(row, 1000));
      const reveal = createLatencyReveal(manifest.meals, 'persisted-offline-random-seed');
      const quality = normalizeQuality(assessment(manifest.runId), reveal, manifest.runId);
      assert.equal(chooseFinalist(manifest, pilot, quality).chosenProfile, 'A');
      const confirmation = manifest.confirmationSchedules.A.map((row) => ({ ...result, ...row }));
      const report = buildLatencyReport(manifest, [...pilot, ...confirmation], quality);
      assert.equal(report.confirmation.summary.latencyMs.median, 60); assert.equal(report.confirmation.passed, true);
    } finally { ledger.close(); }
  });
});
