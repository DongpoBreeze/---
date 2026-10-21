import { createHash } from 'node:crypto';
import { normalizeAnalysis, validPer100g, percentile } from './meal-ab-core.mjs';

export const LATENCY_CONFIG = Object.freeze({ model: 'gpt-6.1-sol', protocol: 'responses', stream: true,
  maxOutputTokens: 8192, timeoutMs: 90_000, imageDetail: 'low', maxStages: 1, retries: 0,
  pilotMeals: 4, confirmationMeals: 10, maxLocalRequests: 22, rawCaptureLimitBytes: 2 * 1024 * 1024 });
export const LATENCY_PROFILES = Object.freeze({
  A: Object.freeze({ promptProfile: 'current', reasoningEffort: 'max' }),
  B: Object.freeze({ promptProfile: 'concise', reasoningEffort: 'max' }),
  C: Object.freeze({ promptProfile: 'concise', reasoningEffort: 'medium' }),
});
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const pilotKeys = ['breakfast_01_', 'breakfast_04_', 'dinner_01_', 'dinner_05_'];
export const pilotOrders = [['A', 'B', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'], ['C', 'B', 'A']];

export function validRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value)) throw new Error('Run ID must be 1–40 letters, numbers, underscores or hyphens.');
  return value;
}
export function selectPilot(meals) {
  if (!Array.isArray(meals) || meals.length !== 10 || new Set(meals.map((row) => row.mealId)).size !== 10) throw new Error('The frozen input must contain ten unique meals.');
  return pilotKeys.map((prefix) => {
    const matches = meals.filter((row) => row.mealId.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`Expected exactly one frozen ${prefix} sample.`);
    return matches[0];
  });
}
export function makeLatencySchedule(meals, runId, phase = 'pilot', profile) {
  validRunId(runId);
  if (!['pilot', 'confirm'].includes(phase) || phase === 'confirm' && !LATENCY_PROFILES[profile]) throw new Error('Invalid experimental phase or profile.');
  const selected = phase === 'pilot' ? selectPilot(meals) : meals;
  return selected.flatMap(({ mealId }, index) => (phase === 'pilot' ? pilotOrders[index] : [profile]).map((id) => ({
    taskId: `${phase}:${id}:${mealId}`, sequence: 0, mealId, profile: id, phase,
    validationRunId: `${runId}-${phase}-${id}`, maxStages: 1,
  }))).map((task, index) => ({ ...task, sequence: index + 1 }));
}

export function emptyTask(task) {
  return { ...task, status: 'not_attempted', transportCompleted: false, businessAccepted: false,
    captureStatus: 'not_started', stages: [], analysis: null, recognition: null, elapsedMs: null, timing: null, error: null };
}
export function canonicalTask(task, record) {
  return { ...emptyTask(task), ...record, taskId: task.taskId, phase: task.phase, profile: task.profile, mealId: task.mealId };
}
export function taskAccepted(row) {
  return row?.transportCompleted === true && row?.businessAccepted === true && row?.stages?.length === 1
    && row.stages[0].transportCompleted === true && row.stages[0].businessAccepted === true;
}
export function normalizedTask(row) {
  return taskAccepted(row) ? normalizeAnalysis(row.analysis, row.recognition) : normalizeAnalysis(null);
}
export function allSampleElapsed(row, timeoutMs = LATENCY_CONFIG.timeoutMs) {
  const elapsed = typeof row?.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 ? row.elapsedMs : null;
  if (row?.status === 'timeout' || row?.error?.code === 'timeout' || row?.status === 'interrupted') return Math.max(timeoutMs, elapsed ?? 0);
  return elapsed ?? timeoutMs;
}
const countBy = (rows, select) => Object.fromEntries(rows.reduce((m, row) => m.set(select(row), (m.get(select(row)) ?? 0) + 1), new Map()));
export function summarizeProfile(rows, denominator = rows.length) {
  const attempted = rows.filter((row) => row.status !== 'not_attempted');
  const valid = rows.filter(taskAccepted), normalized = valid.map(normalizedTask);
  const components = normalized.flatMap((row) => row.components);
  const useful = (row) => validPer100g(row.per100g) && typeof row.recipeBasis === 'string' && row.recipeBasis.trim().length > 0;
  const requests = rows.flatMap((row) => row.stages ?? []);
  const samples = rows.map((row) => allSampleElapsed(row));
  const usageKeys = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens'];
  const usage = Object.fromEntries(usageKeys.map((key) => [key, requests.some((row) => Number.isFinite(row.usage?.[key]))
    ? requests.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0) : null]));
  const firstText = rows.map((row) => row.timing?.firstTextDeltaMs).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const firstBody = rows.map((row) => row.timing?.firstTextMs ?? row.timing?.firstTextDeltaMs).filter((value) => typeof value === 'number' && Number.isFinite(value));
  return { denominator, attempted: attempted.length, requests: requests.length,
    completed: rows.filter((row) => row.transportCompleted === true).length, valid: valid.length,
    useful: normalized.filter((row) => row.components.some(useful)).length, usefulComponents: components.filter(useful).length,
    returnedComponents: components.length,
    latencyMs: { denominator, includesFailuresAndUnattempted: true, timeoutPenaltyMs: LATENCY_CONFIG.timeoutMs,
      median: attempted.length ? percentile(samples, 0.5) : null, p90: attempted.length ? percentile(samples, 0.9) : null,
      allSampleValues: attempted.length ? samples : [] },
    firstTextDeltaMs: { reported: firstText.length, missing: denominator - firstText.length,
      median: percentile(firstText, 0.5), p90: percentile(firstText, 0.9) },
    firstTextMs: { reported: firstBody.length, missing: denominator - firstBody.length,
      median: percentile(firstBody, 0.5), p90: percentile(firstBody, 0.9),
      definition: 'first nonempty assistant output text in delta, output_text.done or completed output; reasoning excluded' },
    usage, usageReportedRequests: requests.filter((row) => row.usage !== null && row.usage !== undefined).length,
    usageMissingRequests: requests.filter((row) => row.usage === null || row.usage === undefined).length,
    usageMissingByField: Object.fromEntries(usageKeys.map((key) => [key, requests.filter((row) => row.usage?.[key] === undefined).length])),
    failures: countBy(rows.filter((row) => !taskAccepted(row)), (row) => row.error?.code ?? row.status),
  };
}

export function createLatencyReveal(meals, seed) {
  if (typeof seed !== 'string' || seed.length < 16) throw new Error('A persisted random blind seed is required.');
  const profiles = Object.keys(LATENCY_PROFILES).sort((a, b) => sha256(`${seed}:profile:${a}`).localeCompare(sha256(`${seed}:profile:${b}`)));
  return { schemaVersion: 'meal-latency-reveal.v1',
    variants: Object.fromEntries(profiles.map((id, index) => [`V${index + 1}`, id])),
    samples: selectPilot(meals).map((row) => row.mealId).sort((a, b) => sha256(`${seed}:meal:${a}`).localeCompare(sha256(`${seed}:meal:${b}`)))
      .map((mealId, index) => ({ sampleId: `M${String(index + 1).padStart(2, '0')}`, mealId })) };
}
export function blindPilotPayload(manifest, records, reveal) {
  return { schemaVersion: 'meal-latency-blind.v1', evidence: 'AI observation with image access; not human ground truth',
    rubric: { recognition: 50, evidenceAndUncertainty: 20, nutritionReferenceUsefulness: 30 },
    instructions: 'Review visible dish coverage, evidence versus recipe assumptions, and all four per-100g references. Do not reward confidence, narrow ranges or length. Mark obvious degradation explicitly; score unavailable/incomplete variants null. No nutrition accuracy claim.',
    samples: reveal.samples.map(({ sampleId, mealId }) => ({ sampleId, image: `images/${sampleId}.jpg`,
      variants: Object.fromEntries(Object.entries(reveal.variants).map(([variant, profile]) => [variant,
        normalizedTask(records.find((row) => row.phase === 'pilot' && row.profile === profile && row.mealId === mealId))])) })) };
}
export function qualityTemplate(runId, reveal) {
  return { schemaVersion: 'meal-latency-quality.v1', runId,
    evidence: 'ai_observation_not_human_truth', reviewer: null, reviewedAt: null,
    rubric: { recognition: 50, evidenceAndUncertainty: 20, nutritionReferenceUsefulness: 30 },
    variants: Object.fromEntries(Object.keys(reveal.variants).map((variant) => [variant, { obviousDegradation: null,
      notes: [], scores: null }])),
    instructions: 'Supply an independent image-and-output review. obviousDegradation must be true or false with concrete notes. Scores are recognition 0..50, evidenceAndUncertainty 0..20, nutritionReferenceUsefulness 0..30; null only for incomplete evidence. Template values are deliberately unassessed.' };
}
export function normalizeQuality(assessment, reveal, runId) {
  if (!assessment || assessment.schemaVersion !== 'meal-latency-quality.v1' || assessment.runId !== runId
    || assessment.evidence !== 'ai_observation_not_human_truth'
    || typeof assessment.reviewer !== 'string' || !assessment.reviewer.trim()
    || typeof assessment.reviewedAt !== 'string' || !Number.isFinite(Date.parse(assessment.reviewedAt))) return { valid: false, reason: 'independent_quality_assessment_missing_or_invalid', profiles: {} };
  const source = assessment.profiles ?? Object.fromEntries(Object.entries(assessment.variants ?? {}).map(([id, value]) => [reveal.variants[id], value]));
  const profiles = {};
  for (const id of Object.keys(LATENCY_PROFILES)) {
    const row = source[id];
    const scores = row?.scores;
    const validScores = scores === null || scores && Object.entries({ recognition: 50, evidenceAndUncertainty: 20, nutritionReferenceUsefulness: 30 })
      .every(([key, max]) => typeof scores[key] === 'number' && Number.isFinite(scores[key]) && scores[key] >= 0 && scores[key] <= max);
    if (!row || typeof row.obviousDegradation !== 'boolean' || !Array.isArray(row.notes) || !row.notes.some((note) => typeof note === 'string' && note.trim())
      || !row.notes.every((note) => typeof note === 'string') || !validScores) return { valid: false, reason: `independent_quality_assessment_incomplete_${id}`, profiles: {} };
    profiles[id] = { obviousDegradation: row.obviousDegradation, notes: row.notes, scores,
      total: scores === null ? null : scores.recognition + scores.evidenceAndUncertainty + scores.nutritionReferenceUsefulness };
  }
  return { valid: true, reason: null, evidence: assessment.evidence, reviewer: assessment.reviewer, reviewedAt: assessment.reviewedAt, profiles };
}
export function chooseFinalist(manifest, records, quality) {
  const pilot = manifest.pilotSchedule.map((task) => canonicalTask(task, records.find((row) => row.taskId === task.taskId)));
  const summaries = Object.fromEntries(Object.keys(LATENCY_PROFILES).map((id) => [id, summarizeProfile(pilot.filter((row) => row.profile === id), 4)]));
  const finished = pilot.every((row) => row.status !== 'not_attempted');
  const fatal = pilot.some((row) => row.fatalPersistenceError);
  if (!finished || fatal || !quality?.valid) return { allowed: false, chosenProfile: null,
    reason: fatal ? 'artifact_or_ledger_persistence_failed' : !finished ? 'pilot_incomplete' : quality?.reason ?? 'independent_quality_assessment_missing', summaries };
  const candidates = Object.keys(LATENCY_PROFILES).filter((id) => summaries[id].valid >= 3 && quality.profiles[id]?.obviousDegradation === false
    && (summaries[id].valid < 4 || quality.profiles[id].scores !== null));
  candidates.sort((a, b) => summaries[b].valid - summaries[a].valid || summaries[a].latencyMs.median - summaries[b].latencyMs.median
    || Number(LATENCY_PROFILES[b].reasoningEffort === 'max') - Number(LATENCY_PROFILES[a].reasoningEffort === 'max') || a.localeCompare(b));
  return { allowed: candidates.length > 0, chosenProfile: candidates[0] ?? null,
    reason: candidates.length ? 'at_least_three_of_four_valid_no_obvious_degradation_ranked_by_valid_then_all_sample_median' : 'no_candidate_met_completion_and_quality_gate',
    ranking: candidates, summaries };
}

export function buildLatencyReport(manifest, records, quality, { ledger = null, gateOverride = null, assessmentSha256 = null } = {}) {
  const gate = gateOverride ?? chooseFinalist(manifest, records, quality);
  const pilot = manifest.pilotSchedule.map((task) => canonicalTask(task, records.find((row) => row.taskId === task.taskId)));
  const confirmationSchedule = gate.chosenProfile ? manifest.confirmationSchedules[gate.chosenProfile] : [];
  const confirmation = confirmationSchedule.map((task) => canonicalTask(task, records.find((row) => row.taskId === task.taskId)));
  const confirmSummary = summarizeProfile(confirmation, 10);
  const confirmationFinished = confirmation.length === 10 && confirmation.every((row) => row.status !== 'not_attempted');
  const pass = confirmationFinished && confirmSummary.valid >= 9 && confirmSummary.latencyMs.median <= 45_000 && confirmSummary.latencyMs.p90 <= 90_000;
  const detail = (row) => ({ ...row, normalized: normalizedTask(row) });
  return { schemaVersion: 'meal-latency-report.v1', runId: manifest.runId, generatedAt: new Date().toISOString(),
    ...(manifest.evidence ? { evidence: manifest.evidence } : {}),
    manifestSha256: manifest.manifestSha256, config: manifest.config, profiles: manifest.profiles,
    configuredProviderAtPreparation: manifest.provider, configuredProviderAtExecution: records.filter((row) => row.configuredProvider).map((row) => ({ taskId: row.taskId, ...row.configuredProvider })),
    ledger, gate, quality: quality ?? { valid: false, reason: 'independent_quality_assessment_missing', profiles: {} }, assessmentSha256,
    pilot: { denominatorPerProfile: 4, profiles: gate.summaries,
      photos: selectPilot(manifest.meals).map((meal) => ({ mealId: meal.mealId, image: meal.prepared,
        profiles: Object.fromEntries(Object.keys(LATENCY_PROFILES).map((id) => [id, detail(pilot.find((row) => row.mealId === meal.mealId && row.profile === id))])) })) },
    confirmation: { status: !gate.allowed ? 'not_run_blocked' : confirmationFinished ? 'complete' : confirmation.some((row) => row.status !== 'not_attempted') ? 'in_progress' : 'pending',
      chosenProfile: gate.chosenProfile, denominator: 10, summary: confirmSummary, samples: confirmation.map(detail),
      successCriteria: { minimumValid: 9, medianMsAtMost: 45_000, p90MsAtMost: 90_000, firstPassOnly: true },
      passed: confirmationFinished ? pass : null },
    contentComparison: { winner: 'undetermined', reason: 'fewer_than_six_complete_pairs',
      completePairs: Object.fromEntries([['A', 'B'], ['A', 'C'], ['B', 'C']].map(([a, b]) => [`${a}_${b}`, selectPilot(manifest.meals).filter(({ mealId }) =>
        taskAccepted(pilot.find((row) => row.mealId === mealId && row.profile === a)) && taskAccepted(pilot.find((row) => row.mealId === mealId && row.profile === b))).length])) },
    limitations: ['AI image/output observation is not human ground truth.', 'No weighed portions, measured recipes or laboratory nutrient truth; references do not establish nutrition accuracy.',
      'Pilot content superiority cannot be declared with fewer than six complete pairs.', 'Same frozen Web-prepared JPEG bytes; Android native preprocessing is not validated.',
      'Every assigned sample remains in completion and latency denominators; absent/timeout/interrupted values use at least 90000 ms.', 'Usage is provider-reported only; missing fields are not estimated.'] };
}
const ms = (value) => value === null || value === undefined ? '—' : `${(value / 1000).toFixed(3)}s`;
export function renderLatencyMarkdown(report) {
  const lines = [`# Meal latency validation — ${report.runId}`, '',
    ...(report.evidence ? ['Synthetic offline fixture only; not a real experiment or nutrition-quality evidence.', ''] : []),
    `Model: ${report.config.model}; Responses streaming; image detail low; 8192 output tokens; 90000 ms per request; one stage; no retries. Local cap: 22 requests.`, '',
    '| Profile | Prompt / effort | Completed / 4 | Business valid / 4 | Useful / 4 | All-4 median / P90 | First text median | Usage reported / missing |',
    '|---|---|---:|---:|---:|---|---|---|'];
  for (const id of Object.keys(LATENCY_PROFILES)) {
    const s = report.pilot.profiles[id], p = report.profiles[id];
    lines.push(`| ${id} | ${p.promptProfile} / ${p.reasoningEffort} | ${s.completed}/4 | ${s.valid}/4 | ${s.useful}/4 | ${ms(s.latencyMs.median)} / ${ms(s.latencyMs.p90)} | ${ms(s.firstTextMs.median)} | ${s.usageReportedRequests} / ${s.usageMissingRequests} |`);
  }
  lines.push('', `Finalist gate: **${report.gate.allowed ? report.gate.chosenProfile : 'blocked'}** — ${report.gate.reason}.`,
    `Quality evidence: ${report.quality.valid ? `${report.quality.reviewer}; AI observation, not human truth` : report.quality.reason}.`, '',
    'First response text includes nonempty output_text.delta, output_text.done or assistant output_text in response.completed; reasoning is excluded. Delta timing remains separately recorded. Elapsed freezes at provider resolve/reject; local archive time is reported separately and excluded from ranking and acceptance metrics.', '',
    '| Photo | Profile | Transport / business / capture | Headers | First event | First text | First output_text.delta | response.completed | Business validated | Returned | Elapsed | Archive | Failure |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const photo of report.pilot.photos) for (const [id, row] of Object.entries(photo.profiles)) {
    const t = row.timing ?? {};
    lines.push(`| ${photo.mealId} | ${id} | ${row.transportCompleted} / ${row.businessAccepted} / ${row.captureStatus} | ${ms(t.headersMs)} | ${ms(t.firstEventMs)} | ${ms(t.firstTextMs ?? t.firstTextDeltaMs)} | ${ms(t.firstTextDeltaMs)} | ${ms(t.responseCompletedMs)} | ${ms(t.businessValidatedMs)} | ${ms(t.returnedMs)} | ${ms(row.elapsedMs)} | ${ms(row.archiveElapsedMs)} | ${row.error?.code ?? '—'} |`);
  }
  lines.push('', 'Per-photo dish identities, evidence, recipe assumptions and all four per-100g ranges:', '');
  for (const photo of report.pilot.photos) for (const [id, row] of Object.entries(photo.profiles)) {
    lines.push(`- ${photo.mealId} / ${id}: ${row.normalized.available ? JSON.stringify(row.normalized) : `unavailable (${row.error?.code ?? row.status})`}`);
  }
  lines.push('', 'Provider-reported usage (null means missing, no estimates):', '');
  for (const [id, s] of Object.entries(report.pilot.profiles)) lines.push(`- ${id}: ${JSON.stringify(s.usage)}; missing by field ${JSON.stringify(s.usageMissingByField)}; failures ${JSON.stringify(s.failures)}.`);
  const c = report.confirmation, s = c.summary;
  lines.push('', `Confirmation: **${c.status}**; selected profile ${c.chosenProfile ?? 'none'}; completed ${s.completed}/10, valid ${s.valid}/10, useful ${s.useful}/10; median ${ms(s.latencyMs.median)}, P90 ${ms(s.latencyMs.p90)}; passed ${c.passed ?? 'pending'}.`,
    'Acceptance: at least 9/10 first-pass valid completions; all-10 median ≤45s; all-10 P90 ≤90s.', '');
  for (const row of c.samples) lines.push(`- ${row.mealId}: ${row.status}; headers ${ms(row.timing?.headersMs)}, first event ${ms(row.timing?.firstEventMs)}, first text ${ms(row.timing?.firstTextMs ?? row.timing?.firstTextDeltaMs)}, first output_text.delta ${ms(row.timing?.firstTextDeltaMs)}, response.completed ${ms(row.timing?.responseCompletedMs)}, business ${ms(row.timing?.businessValidatedMs)}, returned ${ms(row.timing?.returnedMs)}, elapsed ${ms(row.elapsedMs)}; ${row.error?.code ?? 'no failure'}; ${JSON.stringify(row.normalized)}.`);
  lines.push('', `Content winner: undetermined (${report.contentComparison.reason}); complete pairs ${JSON.stringify(report.contentComparison.completePairs)}.`, '', ...report.limitations.map((line) => `- ${line}`), '');
  return lines.join('\n');
}
