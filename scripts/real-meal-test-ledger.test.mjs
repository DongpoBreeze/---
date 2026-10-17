import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealMealTestLedger, REAL_MEAL_LIMITS } from './real-meal-test-ledger.mjs';

const base = (mealId, stage) => ({ mealId, stage, model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 });
const accepted = (ledger, attemptId) => assert.equal(ledger.finish(attemptId, {
  elapsedMs: 25, httpStatus: 200, providerCompleted: true, resultAccepted: true,
  outcome: 'accepted', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, secret: 'drop-me' },
}), true);

async function withLedger(run) {
  const directory = await mkdtemp(join(tmpdir(), 'real-meal-ledger-'));
  const path = join(directory, 'ledger.sqlite');
  try { await run(path); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a failed or timed-out reservation is durable and cannot be retried at the same stage', async () => {
  await withLedger(async (path) => {
    let ledger = new RealMealTestLedger(path);
    const { attemptId } = ledger.reserve({ ...base('meal-failed', 'whole'), validationRunId: 'failed-round' });
    assert.equal(ledger.finish(attemptId, { elapsedMs: 100, httpStatus: 504, outcome: 'request_error', usage: { private: 'ignored' } }), true);
    assert.throws(() => ledger.reserve({ ...base('meal-failed', 'whole'), validationRunId: 'failed-round' }), /already been attempted/);
    ledger.close();

    ledger = new RealMealTestLedger(path);
    assert.equal(ledger.totals().totalRequests, 1);
    assert.equal(ledger.attempts()[0].status, 'request_error');
    assert.equal(ledger.attempts()[0].usage, null);
    const retryInNewRound = ledger.reserve({ ...base('meal-failed', 'whole'), validationRunId: 'timeout-round' });
    assert.equal(ledger.finish(retryInNewRound.attemptId, { elapsedMs: 120_000, httpStatus: 200, outcome: 'timeout' }), true);
    assert.equal(ledger.totals().totalRequests, 2);
    assert.deepEqual(ledger.attempts().map(({ validationRunId, status }) => ({ validationRunId, status })), [
      { validationRunId: 'failed-round', status: 'request_error' },
      { validationRunId: 'timeout-round', status: 'timeout' },
    ]);
    ledger.close();
  });
});

test('each meal allows at most three distinct stages and records fixed model metadata', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  assert.throws(() => ledger.reserve({ ...base('wrong-model', 'whole'), model: 'other-model' }), /fixed for this ledger/);
  assert.throws(() => ledger.reserve({ ...base('wrong-effort', 'whole'), reasoningEffort: 'low' }), /fixed for this ledger/);
  const first = ledger.reserve(base('meal-three', 'whole'));
  accepted(ledger, first.attemptId);
  const review = ledger.reserve(base('meal-three', 'crop_review'));
  accepted(ledger, review.attemptId);
  const merge = ledger.reserve(base('meal-three', 'final_merge'));
  accepted(ledger, merge.attemptId);
  assert.throws(() => ledger.reserve(base('meal-three', 'whole')), /3-request per-meal/);
  assert.deepEqual(ledger.attempts().map(({ model, reasoningEffort, resultVersion }) => ({ model, reasoningEffort, resultVersion })), [
    { model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 },
    { model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 },
    { model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 },
  ]);
  assert.deepEqual(ledger.attempts()[0].usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
  ledger.close();
});

test('per-meal request limits are independent for each validation run', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (const validationRunId of ['round-one', 'round-two']) {
    const first = ledger.reserve({ ...base('meal-repeated', 'whole'), validationRunId });
    accepted(ledger, first.attemptId);
    const review = ledger.reserve({ ...base('meal-repeated', 'crop_review'), validationRunId });
    accepted(ledger, review.attemptId);
    const merge = ledger.reserve({ ...base('meal-repeated', 'final_merge'), validationRunId });
    accepted(ledger, merge.attemptId);
    assert.throws(() => ledger.reserve({ ...base('meal-repeated', 'whole'), validationRunId }), /3-request per-meal/);
    assert.equal(ledger.attemptsForRun(validationRunId, 'meal-repeated').length, 3);
  }
  assert.equal(ledger.totals().totalRequests, 6);
  ledger.close();
});

test('final merge requires a successfully accepted crop review', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  const first = ledger.reserve(base('meal-order', 'whole'));
  accepted(ledger, first.attemptId);
  assert.throws(() => ledger.reserve(base('meal-order', 'final_merge')), /accepted crop review/);
  assert.equal(ledger.totals().totalRequests, 1);
  ledger.close();
});

test('the 50 first-pass capacity rejects the 51st meal in one run', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < REAL_MEAL_LIMITS.cohortMeals; index += 1) {
    const { attemptId } = ledger.reserve(base(`first-${index}`, 'whole'));
    accepted(ledger, attemptId);
  }
  assert.throws(() => ledger.reserve(base('first-50', 'whole')), /50 first-pass/);
  assert.equal(ledger.totals().firstPassMeals, 50);
  ledger.close();
});

test('each validation run has its own 50-meal first-pass capacity', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < 25; index += 1) {
    const first = ledger.reserve({ ...base(`cohort-old-${index}`, 'whole'), validationRunId: 'cohort-old-round' });
    accepted(ledger, first.attemptId);
  }
  for (let index = 0; index < REAL_MEAL_LIMITS.cohortMeals; index += 1) {
    const first = ledger.reserve({ ...base(`cohort-new-${index}`, 'whole'), validationRunId: 'cohort-new-round' });
    accepted(ledger, first.attemptId);
  }
  assert.throws(() => ledger.reserve({ ...base('cohort-new-50', 'whole'), validationRunId: 'cohort-new-round' }), /50 first-pass/);
  assert.equal(ledger.totals().totalRequests, REAL_MEAL_LIMITS.totalRequests);
  ledger.close();
});

test('only 25 distinct meals may use additional review capacity', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < REAL_MEAL_LIMITS.cohortMeals; index += 1) {
    const mealId = `review-${index}`;
    const first = ledger.reserve(base(mealId, 'whole'));
    accepted(ledger, first.attemptId);
  }
  for (let index = 0; index < REAL_MEAL_LIMITS.reviewMeals; index += 1) {
    const review = ledger.reserve(base(`review-${index}`, 'crop_review'));
    accepted(ledger, review.attemptId);
  }
  assert.throws(() => ledger.reserve(base('review-25', 'crop_review')), /25-meal additional-review/);
  assert.equal(ledger.totals().reviewedMeals, REAL_MEAL_LIMITS.reviewMeals);
  ledger.close();
});

test('the 25-meal review capacity is independent for each validation run', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < REAL_MEAL_LIMITS.reviewMeals; index += 1) {
    const mealId = `round-review-${index}`;
    const first = ledger.reserve({ ...base(mealId, 'whole'), validationRunId: 'review-round-one' });
    accepted(ledger, first.attemptId);
    const review = ledger.reserve({ ...base(mealId, 'crop_review'), validationRunId: 'review-round-one' });
    accepted(ledger, review.attemptId);
  }
  const nextRoundFirst = ledger.reserve({ ...base('round-review-0', 'whole'), validationRunId: 'review-round-two' });
  accepted(ledger, nextRoundFirst.attemptId);
  const nextRoundReview = ledger.reserve({ ...base('round-review-0', 'crop_review'), validationRunId: 'review-round-two' });
  accepted(ledger, nextRoundReview.attemptId);
  assert.equal(ledger.attemptsForRun('review-round-two').filter(({ stage }) => stage !== 'whole').length, 1);
  assert.equal(ledger.totals().reviewedMeals, REAL_MEAL_LIMITS.reviewMeals);
  ledger.close();
});

test('a new validation run can use remaining global request capacity', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < REAL_MEAL_LIMITS.cohortMeals; index += 1) {
    const first = ledger.reserve({ ...base(`reserved-${index}`, 'whole'), validationRunId: 'old-round' });
    accepted(ledger, first.attemptId);
  }

  const nextRoundFirst = ledger.reserve({ ...base('reserved-0', 'whole'), validationRunId: 'new-round' });
  accepted(ledger, nextRoundFirst.attemptId);
  const nextRoundReview = ledger.reserve({ ...base('reserved-0', 'crop_review'), validationRunId: 'new-round' });
  accepted(ledger, nextRoundReview.attemptId);
  assert.equal(ledger.totals().firstPassMeals, REAL_MEAL_LIMITS.cohortMeals);
  assert.equal(ledger.totals().totalRequests, REAL_MEAL_LIMITS.cohortMeals + 2);
  ledger.close();
});

test('the persistent total budget rejects request 76 after all 50 first passes and 25 reviews', async () => {
  const ledger = new RealMealTestLedger(':memory:');
  for (let index = 0; index < REAL_MEAL_LIMITS.cohortMeals; index += 1) {
    const mealId = `budget-${index}`;
    const first = ledger.reserve(base(mealId, 'whole'));
    accepted(ledger, first.attemptId);
    if (index < REAL_MEAL_LIMITS.reviewMeals) {
      const review = ledger.reserve(base(mealId, 'crop_review'));
      accepted(ledger, review.attemptId);
    }
  }
  assert.equal(ledger.totals().totalRequests, REAL_MEAL_LIMITS.totalRequests);
  assert.throws(() => ledger.reserve(base('budget-0', 'final_merge')), /75-request/);
  assert.throws(() => ledger.reserve({ ...base('budget-0', 'whole'), validationRunId: 'budget-round-two' }), /75-request/);
  assert.equal(ledger.totals().totalRequests, REAL_MEAL_LIMITS.totalRequests);
  ledger.close();
});
