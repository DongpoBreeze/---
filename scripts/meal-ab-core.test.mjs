import test from 'node:test';
import assert from 'node:assert/strict';
import { createRevealMap, FROZEN_CONFIG, makeSchedule, mergeTrialResults, validateDirect, compareTrial, renderTrialMarkdown } from './meal-ab-core.mjs';

const meals = Array.from({ length: 10 }, (_, index) => ({ mealId: `${index < 5 ? 'breakfast' : 'dinner'}_${String(index % 5 + 1).padStart(2, '0')}` }));
const stage = (attemptId, analysis = { components: [{ label: '成品菜', source: { method: 'ai-per100g-v3', per100gRange: { calories: { min: 100, max: 200 }, protein: { min: 2, max: 4 }, carbs: { min: 10, max: 20 }, fat: { min: 1, max: 3 } }, recipeBasis: '通常配方', assumptions: [] } }] }) => ({ attemptId, stage: 'whole', status: 'accepted', accepted: true, providerCompleted: true, resultAccepted: true, analysis });

test('frozen schedule interleaves project-first and direct-first pairs', () => {
  const schedule = makeSchedule(meals);
  assert.equal(schedule.length, 20);
  assert.deepEqual(schedule.slice(0, 4).map(({ group, maxStages }) => [group, maxStages]), [['project', 2], ['direct', 1], ['direct', 1], ['project', 2]]);
  assert.equal(new Set(schedule.map(({ validationRunId }) => validationRunId)).size, 2);
  assert.throws(() => makeSchedule(meals.slice(0, 9)), /ten unique/);
});

test('direct contract rejects missing references and never converts unknown to zero', () => {
  const unknown = { components: [{ label: '菜', evidence: ['可见'], uncertainty: ['配方不明'], per100g: null, recipeBasis: null, assumptions: ['未知'] }], uncertainty: [] };
  assert.deepEqual(validateDirect(JSON.stringify(unknown)), unknown);
  assert.throws(() => validateDirect(JSON.stringify({ ...unknown, components: [{ ...unknown.components[0], per100g: { calories: { min: 0, max: 0 }, protein: { min: 0, max: 0 }, carbs: { min: 0, max: 0 }, fat: { min: 0, max: 0 } }, recipeBasis: 'x' }] })), /schema/);
});

test('results preserve accepted stage identity, all ten meal denominator rows and blind reveal', () => {
  const manifest = { runId: 'test-run', meals: meals.map((meal) => ({ ...meal })) };
  const records = meals.flatMap((meal, index) => [{ mealId: meal.mealId, group: 'project', status: 'accepted', workflowCompleted: true, stages: [stage(index * 2 + 1)], returnedStage: 'whole', returnedAttemptId: index * 2 + 1, analysis: stage(index * 2 + 1).analysis, elapsedMs: index + 1 }, { mealId: meal.mealId, group: 'direct', status: 'accepted', workflowCompleted: true, stages: [stage(index * 2 + 2)], returnedStage: 'whole', returnedAttemptId: index * 2 + 2, analysis: stage(index * 2 + 2).analysis, elapsedMs: index + 2 }]);
  const results = mergeTrialResults(manifest, records, records.flatMap((record) => record.stages.map((item) => ({ ...item, group: record.group, mealId: record.mealId }))));
  assert.equal(results.meals.length, 10); assert.equal(results.meals[0].project.returnedAttemptId, 1);
  const reveal = createRevealMap(meals, '0123456789abcdef0123456789abcdef');
  assert.equal(reveal.entries.length, 10); assert.equal(new Set(reveal.entries.map((entry) => entry.sampleId)).size, 10);
  const comparison = compareTrial(results, reveal);
  assert.equal(comparison.groups.project.denominatorMeals, 10); assert.equal(comparison.groups.direct.denominatorMeals, 10);
  assert.equal(comparison.content.eligiblePairs, 10); assert.equal(comparison.content.winner, 'undetermined');
  assert.match(renderTrialMarkdown(comparison), /失败样本保留分母/);
});

test('configuration freezes the required transport and stages', () => {
  assert.equal(FROZEN_CONFIG.stream, true); assert.equal(FROZEN_CONFIG.maxOutputTokens, 8192); assert.equal(FROZEN_CONFIG.timeoutMs, 90000);
  assert.deepEqual(FROZEN_CONFIG.groups, { project: { maxStages: 2 }, direct: { maxStages: 1 } });
  assert.equal(FROZEN_CONFIG.ledgerLimits.totalRequests, null);
});
