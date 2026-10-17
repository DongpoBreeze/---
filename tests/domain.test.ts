import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, mealCalories, parseSleepTimes, recordLocalDate, refreshSummaries, removeRecord, sleepStats, summaryInputSnapshot, summaryMarkdown, trainingAdvice } from '../src/domain';
import { emptyData, MealRecord, TrainingRecord } from '../src/types';

test('sleep crosses midnight and preserves unknown waking duration', () => {
  const times = parseSleepTimes('2026-10-10', '23:30', '07:00');
  assert.equal(localDate(times.wokeAt), '2026-10-10');
  assert.deepEqual(sleepStats({ ...times, awakeMinutes: 30 }), { intervalMinutes: 450, asleepMinutes: 420 });
  assert.equal(sleepStats({ ...times, awakeMinutes: null }).asleepMinutes, null);
  assert.equal(sleepStats({ ...times, awakeMinutes: 0 }).asleepMinutes, 450);
  assert.throws(() => sleepStats({ ...times, awakeMinutes: 451 }));
  assert.throws(() => parseSleepTimes('2026-02-30', '23:00', '07:00'));
  assert.throws(() => parseSleepTimes('2026-10-10', '29:00', '07:00'));
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
  const summary = summaryMarkdown({ ...emptyData(), meals: [meal] }, '2026-10-10');
  assert.match(summary, /已填写菜品小计 130～130 kcal/);
  assert.match(summary, /数据不完整/);
  assert.match(summary, /未计入：烤鸡肉/);
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
