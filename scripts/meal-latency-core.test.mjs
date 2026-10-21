import test from 'node:test';
import assert from 'node:assert/strict';
import { LATENCY_CONFIG, LATENCY_PROFILES, makeLatencySchedule, selectPilot, createLatencyReveal, blindPilotPayload,
  qualityTemplate, normalizeQuality, chooseFinalist, summarizeProfile, buildLatencyReport, renderLatencyMarkdown } from './meal-latency-core.mjs';
import { fixtureManifest, acceptedRecord, assessment } from './meal-latency-test-helpers.mjs';

test('pilot freezes exactly four specified images and the 12 interleaved one-stage conditions', () => {
  const m = fixtureManifest();
  assert.deepEqual(selectPilot(m.meals).map((row) => row.mealId.slice(0, 12)), ['breakfast_01', 'breakfast_04', 'dinner_01_fi', 'dinner_05_fi'].map((s) => s.slice(0, 12)));
  assert.equal(m.pilotSchedule.length, 12);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => m.pilotSchedule.slice(i * 3, i * 3 + 3).map((row) => row.profile)),
    [['A', 'B', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A']]);
  assert.equal(new Set(m.pilotSchedule.map((row) => row.taskId)).size, 12);
  assert.equal(new Set(m.pilotSchedule.map((row) => row.validationRunId)).size, 3);
  const confirm = makeLatencySchedule(m.meals, m.runId, 'confirm', 'B');
  assert.equal(confirm.length, 10);
  assert.equal(new Set(confirm.map((row) => row.validationRunId)).size, 1);
  assert.ok(confirm.every((row) => row.profile === 'B' && row.maxStages === 1 && row.phase === 'confirm'));
  assert.ok(confirm.every((row) => !m.pilotSchedule.some((pilot) => pilot.taskId === row.taskId || pilot.validationRunId === row.validationRunId)));
  assert.deepEqual(LATENCY_PROFILES, { A: { promptProfile: 'current', reasoningEffort: 'max' }, B: { promptProfile: 'concise', reasoningEffort: 'max' }, C: { promptProfile: 'concise', reasoningEffort: 'medium' } });
  assert.equal(LATENCY_CONFIG.model, 'gpt-6.1-sol'); assert.equal(LATENCY_CONFIG.maxOutputTokens, 8192); assert.equal(LATENCY_CONFIG.timeoutMs, 90000);
});

test('quality template stays explicitly unassessed and blind outputs exclude condition and timing metadata', () => {
  const m = fixtureManifest(), reveal = createLatencyReveal(m.meals, 'persisted-offline-random-seed');
  const records = m.pilotSchedule.map((task) => acceptedRecord(task));
  const template = qualityTemplate(m.runId, reveal);
  assert.ok(Object.values(template.variants).every((row) => row.obviousDegradation === null && row.scores === null));
  assert.equal(normalizeQuality(template, reveal, m.runId).valid, false);
  const blind = blindPilotPayload(m, records, reveal);
  const text = JSON.stringify(blind);
  assert.equal(blind.samples.length, 4);
  for (const forbidden of ['reasoningEffort', 'promptProfile', 'elapsedMs', 'stageCount', 'validationRunId', 'offline-fixture', 'breakfast_01_fixture']) assert.ok(!text.includes(forbidden));
  assert.equal(blind.samples[0].variants.V1.components[0].per100g.calories.min, 120);
  const reviewed = assessment(m.runId);
  reviewed.variants = Object.fromEntries(Object.entries(reveal.variants).map(([key, profile]) => [key, reviewed.profiles[profile]]));
  delete reviewed.profiles;
  assert.equal(normalizeQuality(reviewed, reveal, m.runId).valid, true);
});

test('finalist gate fails closed without review or a >=3/4 valid candidate; deterministic ties prefer max then A', () => {
  const m = fixtureManifest(), reveal = createLatencyReveal(m.meals, 'persisted-offline-random-seed');
  const records = m.pilotSchedule.map((task) => acceptedRecord(task));
  assert.equal(chooseFinalist(m, records, null).allowed, false);
  const quality = normalizeQuality(assessment(m.runId), reveal, m.runId);
  assert.equal(chooseFinalist(m, records, quality).chosenProfile, 'A');
  const noA = normalizeQuality(assessment(m.runId, { A: { obviousDegradation: true } }), reveal, m.runId);
  assert.equal(chooseFinalist(m, records, noA).chosenProfile, 'B');
  const none = normalizeQuality(assessment(m.runId, { A: { obviousDegradation: true }, B: { obviousDegradation: true }, C: { obviousDegradation: true } }), reveal, m.runId);
  assert.equal(chooseFinalist(m, records, none).reason, 'no_candidate_met_completion_and_quality_gate');
  const fewer = records.map((row, index) => index < 6 ? { ...row, status: 'timeout', businessAccepted: false, elapsedMs: 90050, error: { code: 'timeout' } } : row);
  assert.equal(chooseFinalist(m, fewer, quality).allowed, false);
  assert.equal(chooseFinalist(m, records.slice(0, -1), quality).reason, 'pilot_incomplete');
});

test('finalist ranks valid count before all-four median; timeouts include cancellation overhead', () => {
  const m = fixtureManifest(), reveal = createLatencyReveal(m.meals, 'persisted-offline-random-seed');
  const quality = normalizeQuality(assessment(m.runId), reveal, m.runId);
  const records = m.pilotSchedule.map((task) => acceptedRecord(task, task.profile === 'A' ? 30000 : 10000));
  records.find((row) => row.profile === 'B').businessAccepted = false;
  records.find((row) => row.profile === 'B').status = 'timeout';
  records.find((row) => row.profile === 'B').elapsedMs = 90070;
  records.find((row) => row.profile === 'C').businessAccepted = false;
  records.find((row) => row.profile === 'C').status = 'timeout';
  assert.equal(chooseFinalist(m, records, quality).chosenProfile, 'A');
  const stats = summarizeProfile(records.filter((row) => row.profile === 'B'), 4);
  assert.equal(stats.valid, 3); assert.equal(stats.latencyMs.median, 10000);
  assert.equal(stats.latencyMs.allSampleValues.length, 4); assert.ok(stats.latencyMs.allSampleValues.includes(90070));
  assert.equal(stats.latencyMs.p90, 66049.00000000001);
});

test('report retains per-photo four references, first-text timelines, missing usage, failure denominators and pending confirmation', () => {
  const m = fixtureManifest(), records = m.pilotSchedule.map((task) => acceptedRecord(task));
  const failed = records[2]; failed.businessAccepted = false; failed.status = 'schema_error'; failed.error = { code: 'invalid_response' };
  failed.stages[0].usage = { input_tokens: 7, output_tokens: 4, total_tokens: 11, cached_input_tokens: 3, reasoning_tokens: 2 };
  const report = buildLatencyReport(m, records, null);
  assert.equal(report.pilot.profiles.C.denominator, 4); assert.equal(report.pilot.profiles.C.valid, 3);
  assert.equal(report.pilot.profiles.C.usageMissingRequests, 3); assert.equal(report.pilot.profiles.C.usage.reasoning_tokens, 2);
  assert.equal(report.pilot.photos[0].profiles.A.normalized.components[0].per100g.fat.max, 3);
  assert.equal(report.confirmation.status, 'not_run_blocked'); assert.equal(report.confirmation.passed, null);
  assert.equal(report.contentComparison.winner, 'undetermined');
  const text = renderLatencyMarkdown(report);
  assert.match(text, /First output_text.delta/); assert.match(text, /Business validated/); assert.match(text, /Returned/);
  assert.match(text, /AI image\/output observation is not human ground truth/);
});

test('confirmation success uses all ten first attempts and permits no content winner with only four pairs', () => {
  const m = fixtureManifest(), reveal = createLatencyReveal(m.meals, 'persisted-offline-random-seed');
  const quality = normalizeQuality(assessment(m.runId), reveal, m.runId);
  const pilot = m.pilotSchedule.map((task) => acceptedRecord(task, 20000));
  const confirm = m.confirmationSchedules.A.map((task) => acceptedRecord(task, 40000));
  confirm[9] = { ...confirm[9], businessAccepted: false, status: 'timeout', elapsedMs: 90100, error: { code: 'timeout' } };
  const report = buildLatencyReport(m, [...pilot, ...confirm], quality);
  assert.equal(report.gate.chosenProfile, 'A'); assert.equal(report.confirmation.summary.valid, 9);
  assert.equal(report.confirmation.summary.latencyMs.denominator, 10); assert.equal(report.confirmation.summary.latencyMs.median, 40000);
  assert.equal(report.confirmation.passed, true); assert.equal(report.contentComparison.winner, 'undetermined');
  confirm[8].elapsedMs = 100000;
  assert.equal(buildLatencyReport(m, [...pilot, ...confirm], quality).confirmation.passed, false);
});
