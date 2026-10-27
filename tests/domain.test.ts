import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, mealCalories, parseSleepTimes, recordLocalDate, refreshSummaries, removeRecord, sleepStats, summaryInputSnapshot, summaryMarkdown, trainingAdvice } from '../src/domain';
import { emptyData, MealRecord, TrainingRecord } from '../src/types';
import { calculateMealNutrition } from '../shared/nutrition.mjs';

test('sleep crosses midnight and uses entered times when optional waking duration is absent', () => {
  const times = parseSleepTimes('2026-10-10', '23:30', '07:00');
  assert.equal(localDate(times.wokeAt), '2026-10-10');
  assert.deepEqual(sleepStats({ ...times, awakeMinutes: 30 }), { intervalMinutes: 450, asleepMinutes: 420 });
  const record = { ...times, awakeMinutes: null };
  assert.equal(sleepStats(record).asleepMinutes, 450);
  assert.equal(record.awakeMinutes, null);
  assert.equal(sleepStats({ ...times, awakeMinutes: 0 }).asleepMinutes, 450);
  assert.throws(() => sleepStats({ ...times, awakeMinutes: 451 }));
  assert.throws(() => parseSleepTimes('2026-02-30', '23:00', '07:00'));
  assert.throws(() => parseSleepTimes('2026-10-10', '29:00', '07:00'));
});

test('sleep summaries use valid times and omit missing optional fields without changing raw records', () => {
  const times = parseSleepTimes('2026-10-10', '23:30', '07:00');
  const record = { id: 'sleep-optional', type: 'sleep' as const, createdAt: times.wokeAt,
    occurredAt: times.wokeAt, ...times, awakeMinutes: null, note: '' };
  const summary = summaryMarkdown({ ...emptyData(), sleeps: [record] }, '2026-10-10');
  assert.match(summary, /估算睡眠 7\.5 小时/);
  assert.doesNotMatch(summary, /未知|未填写|主观质量|清醒/);
  assert.equal(record.awakeMinutes, null);
  const adjusted = summaryMarkdown({ ...emptyData(), sleeps: [{ ...record, awakeMinutes: 30, quality: 4 }] }, '2026-10-10');
  assert.match(adjusted, /估算睡眠 7\.0 小时；清醒 30 分钟；主观质量 4\/5/);
});

function training(reps = [12, 12, 12]): TrainingRecord {
  return { id: 'current', type: 'training', createdAt: '2026-10-10T10:00:00Z', occurredAt: '2026-10-10T10:00:00Z', exercise: '哑铃卧推', sets: reps.map((r) => ({ reps: r, weight: 20, unit: 'kg' })), note: '', pain: 'no', controlled: 'yes', rir: '2', targetSets: 3, targetMin: 8, targetMax: 12, increment: 2, weightBasis: 'per-hand' };
}
test('training increases only with comparable history and safe feedback', () => {
  const prior = { ...training(), id: 'prior', occurredAt: '2026-10-09T10:00:00Z' };
  assert.match(trainingAdvice(training(), [prior]), /22 kg/);
  assert.match(trainingAdvice(training([12, 10, 8]), [prior]), /12\/11\/9/);
  for (const change of [{ pain: 'yes' as const }, { controlled: 'no' as const }, { rir: '1' as const }, { rir: 'unknown' as const }, { targetSets: undefined }]) assert.doesNotMatch(trainingAdvice({ ...training(), ...change }, [prior]), /22 kg/);
  assert.doesNotMatch(trainingAdvice(training(), []), /22 kg/);
  assert.doesNotMatch(trainingAdvice(training(), [{ ...prior, weightBasis: 'total' }]), /22 kg/);
  assert.doesNotMatch(trainingAdvice({ ...training(), weightBasis: undefined }, [prior]), /下次可尝试/);
  const noExternalWeight = { ...training(), sets: training().sets.map((set) => ({ ...set, weight: 0 })) };
  assert.doesNotMatch(trainingAdvice(noExternalWeight, [{ ...noExternalWeight, id: 'prior', occurredAt: prior.occurredAt }]), /下次可尝试/);
  assert.match(trainingAdvice(training([14, 10, 8]), [prior]), /12\/11\/9/);
});

test('training summaries retain actual work and supplied feedback while omitting missing optional feedback', () => {
  const original = { ...training(), pain: 'unknown' as const, controlled: 'unknown' as const, rir: 'unknown' as const,
    targetMin: undefined, targetMax: undefined, increment: undefined };
  const summary = summaryMarkdown({ ...emptyData(), trainings: [original] }, localDate(original.occurredAt));
  assert.match(summary, /哑铃卧推：工作组 20 kg × 12 次/);
  assert.doesNotMatch(summary, /未填写|疼痛：|动作可控：|最少剩余次数：/);
  assert.match(trainingAdvice(original, []), /补充目标/);
  const supplied = summaryMarkdown({ ...emptyData(), trainings: [{ ...original, pain: 'yes', controlled: 'no', rir: '1' }] }, localDate(original.occurredAt));
  assert.match(supplied, /疼痛：有；动作可控：否；最少剩余次数：1/);
  assert.match(supplied, /暂停增加负荷/);
});

test('summary changes become stale and deletion removes dependent AI history', () => {
  const data = emptyData();
  data.sourceVersion = 2;
  data.summaries = [{ id: 'ai', date: '2026-10-10', markdown: 'private', sourceVersion: 1, status: 'current', createdAt: '2026-10-10T10:00:00Z', source: 'ai', sourceRecordIds: ['meal1'] }];
  assert.equal(refreshSummaries(data).summaries.find((r) => r.id === 'ai')?.status, 'stale');
  assert.equal(removeRecord(data, 'meal', 'meal1').summaries.some((r) => r.id === 'ai'), false);
});

test('an old estimate does not masquerade as current nutrition', () => {
  const meal = { id: 'meal', type: 'meal' as const, createdAt: '', occurredAt: '', mealType: '午餐' as const, foodName: '饭', portion: '', note: '', source: 'photo' as const, estimateStatus: 'estimated' as const, revision: 2, analyses: [{ id: 'a', model: 'mock', createdAt: '', sourceVersion: 1, analysis: { status: 'estimated' as const, foodName: '饭', calories: { min: 300, max: 500 }, protein: null, carbs: null, fat: null, assumptions: [], advice: '' } }] };
  assert.equal(mealCalories(meal), null);
});

test('manual nutrition is counted even when the record includes a photo', () => {
  const meal: MealRecord = { id: 'photo-meal', type: 'meal', createdAt: '2026-10-10T12:00:00Z', occurredAt: '2026-10-10T12:00:00Z', mealType: '午餐', foodName: '饭', portion: '一碗', note: '', source: 'photo', imageUri: 'file:///meal.jpg', estimateStatus: 'estimated', estimate: { calories: 350, protein: 20, carbs: 40, fat: 12 } };
  assert.deepEqual(mealCalories(meal), { min: 350, max: 350 });
});

test('daily summary counts entered-dish subtotals and names excluded dishes', () => {
  const now = '2026-10-10T12:00:00.000Z';
  const meal: MealRecord = { id: 'partial', type: 'meal', createdAt: now, occurredAt: now, mealType: '午餐', foodName: '米饭和鸡肉', portion: '', note: '', source: 'photo', estimateStatus: 'unknown', analyses: [{
    id: 'analysis', model: 'local/usda', createdAt: now, sourceVersion: 1,
    analysis: { status: 'approximate', foodName: '米饭和鸡肉', calories: { min: 130, max: 130 }, protein: { min: 2.69, max: 2.69 }, carbs: { min: 28.2, max: 28.2 }, fat: { min: 0.28, max: 0.28 }, assumptions: [], advice: '',
      coverage: { matched: 2, total: 2, unknownLabels: [], counted: 1, missingQuantityLabels: ['烤鸡肉'], unknownNutritionLabels: [] },
      nutritionSource: { provider: 'usda-fdc', method: 'user-quantity-v2', coverage: 'incomplete' } },
  }] };
  assert.deepEqual(mealCalories(meal), { min: 130, max: 130 });
  for (const method of ['user-quantity-v2', 'reference-quantity-v1']) {
    meal.analyses![0].analysis.nutritionSource!.method = method;
    const summary = summaryMarkdown({ ...emptyData(), meals: [meal] }, '2026-10-10');
    assert.match(summary, /已填写菜品小计 130～130 kcal/);
    assert.match(summary, /数据不完整/);
    assert.match(summary, /未计入：烤鸡肉/);
  }
});

test('v3 daily summary counts only entered quantities and discloses unknown references', () => {
  const now = '2026-10-17T04:00:00.000Z';
  const estimate = { basisGrams: 100 as const, method: 'typical_recipe' as const, per100g: {
    calories: { min: 200, max: 240 }, protein: { min: 10, max: 20 }, carbs: { min: 10, max: 20 }, fat: { min: 10, max: 20 },
  }, recipeBasis: '按典型成品菜配方。', assumptions: [], confidence: 0.8 };
  const dish = { foodId: null, label: '鸡肉主菜', uncertainty: [], nutritionEstimate: estimate };
  const recognition = { foodName: '鸡肉和配菜', components: [dish], unresolved: [], assumptions: [], advice: '填写实际数量。' };
  const options = { mode: 'ai-per100g-v3' as const, provenance: { model: 'test/model', createdAt: now } };
  const reference = calculateMealNutrition(recognition, undefined, options);
  const partial = calculateMealNutrition({ ...recognition, components: [{ ...dish, userQuantity: { amount: 250, unit: 'g' } },
    { foodId: null, label: '未知配菜', uncertainty: ['没有可用配方。'], nutritionEstimate: null, userQuantity: { amount: 80, unit: 'g' } },
  ] }, undefined, options);
  const record = (id: string, analysis: typeof reference): MealRecord => ({ id, type: 'meal', createdAt: now, occurredAt: now, timezone: 'UTC',
    mealType: '午餐', foodName: analysis.foodName, portion: '', note: '', source: 'photo', estimateStatus: 'unknown',
    analyses: [{ id: `${id}-analysis`, model: 'test/model', createdAt: now, sourceVersion: 1, analysis }] });
  const referenceMeal = record('reference-only', reference);
  const partialMeal = record('partial-ai', partial);
  assert.equal(mealCalories(referenceMeal), null);
  assert.deepEqual(mealCalories(partialMeal), { min: 500, max: 600 });
  const summary = summaryMarkdown({ ...emptyData(), meals: [referenceMeal, partialMeal] }, '2026-10-17');
  assert.match(summary, /已填写菜品小计 500～600 kcal/);
  assert.match(summary, /1 餐未记录热量或可计算的食用量/);
  assert.match(summary, /未计入：未知配菜/);
  assert.match(summary, /有效营养参考/);
  assert.doesNotMatch(summary, /700～840 kcal/);
});

test('record dates stay in their recorded timezone and summaries retain input snapshots', () => {
  const data = emptyData();
  data.profile = { goal: 'muscle-gain' };
  const record = { ...training(), occurredAt: '2026-10-09T18:00:00Z', timezone: 'Asia/Shanghai', pain: 'yes' as const };
  data.trainings = [record];
  assert.equal(recordLocalDate(record), '2026-10-10');
  const markdown = summaryMarkdown(data, '2026-10-10');
  assert.ok(markdown.includes('\n## 训练\n'));
  assert.match(markdown, /疼痛：有/);
  assert.match(markdown, /暂停增加负荷/);
  const snapshot = summaryInputSnapshot(data, '2026-10-10');
  assert.deepEqual(snapshot.recordVersions, [{ id: record.id, version: record.createdAt }]);
  assert.equal(snapshot.summary, markdown);
  data.profile.goal = 'health';
  assert.equal(snapshot.profile.goal, 'muscle-gain');
});

test('deleting a historical training reference removes summaries derived from it', () => {
  const data = emptyData();
  const current = { ...training(), timezone: 'UTC' };
  const previous = { ...training(), id: 'prior', occurredAt: '2026-10-09T10:00:00Z', timezone: 'UTC' };
  data.trainings = [current, previous];
  const inputSnapshot = summaryInputSnapshot(data, '2026-10-10');
  assert.deepEqual(inputSnapshot.recordVersions.map((entry) => entry.id), ['current', 'prior']);
  data.summaries = [{ id: 'ai', date: '2026-10-10', markdown: 'advice', sourceVersion: 0, status: 'current', createdAt: current.createdAt, source: 'ai', sourceRecordIds: ['current'], inputSnapshot }];
  data.drafts = { training: previous };
  const deleted = removeRecord(data, 'training', 'prior');
  assert.equal(deleted.summaries.some((summary) => summary.id === 'ai'), false);
  assert.equal(deleted.drafts?.training, undefined);
});
