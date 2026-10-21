import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { RealMealTestLedger, REAL_MEAL_LIMITS, REAL_MEAL_LEDGER_PATHS, resolveRealMealLedgerPaths } from './real-meal-test-ledger.mjs';

const base = (mealId, stage) => ({ mealId, stage, model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 2 });
const accepted = (ledger, attemptId) => assert.equal(ledger.finish(attemptId, {
  elapsedMs: 25, httpStatus: 200, providerCompleted: true, resultAccepted: true,
  outcome: 'accepted', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, secret: 'drop-me' },
}), true);

test('explicit uncapped experiments retain read-only history beyond 75 with distinct 2/1 stage policies', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    const firstHistory = seedFirstPasses(path, 12, 'history-a');
    const secondHistory = seedFirstPasses(peerPath, 51, 'history-b');
    const activePath = join(path, '..', 'experiment.sqlite');
    const options = { relatedLedgerPaths: [path, peerPath], limits: { totalRequests: null, perMealRequests: 2, reviewMeals: 10, cohortMeals: 10 },
      runLimits: { direct: { perMealRequests: 1, reviewMeals: 0 }, project: { perMealRequests: 2 } } };
    const ledger = new RealMealTestLedger(activePath, options);
    try {
      assert.equal(ledger.coordinator, ledger.db);
      for (let index = 0; index < 10; index += 1) {
        for (const validationRunId of ['project', 'direct']) {
          const whole = ledger.reserve({ ...base(`meal-${index}`, 'whole'), validationRunId });
          accepted(ledger, whole.attemptId);
          if (validationRunId === 'project') {
            const review = ledger.reserve({ ...base(`meal-${index}`, 'crop_review'), validationRunId });
            accepted(ledger, review.attemptId);
          }
        }
      }
      assert.equal(ledger.totals().totalRequests, 93);
      assert.equal(ledger.totals().relatedRequests, 63);
      assert.equal(ledger.totals().localRequests, 30);
      assert.equal(ledger.totals().remainingRequests, null);
      assert.equal(ledger.totals().budgetScope, 'related-ledgers-read-only');
      assert.throws(() => ledger.reserve({ ...base('meal-0', 'crop_review'), validationRunId: 'direct' }), /1-request/);
      assert.throws(() => ledger.reserve({ ...base('meal-0', 'final_merge'), validationRunId: 'project' }), /2-request/);
      assert.throws(() => ledger.reserve({ ...base('eleventh', 'whole'), validationRunId: 'project' }), /10 first-pass/);
    } finally { ledger.close(); }
    const a = new RealMealTestLedger(path); const b = new RealMealTestLedger(peerPath);
    try { assert.deepEqual(a.attempts(), firstHistory); assert.deepEqual(b.attempts(), secondHistory); }
    finally { a.close(); b.close(); }
    assert.throws(() => new RealMealTestLedger(activePath), /limits do not match/);
    new RealMealTestLedger(activePath, options).close();
  });
});

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

async function withTwoLedgers(run) {
  await withLedger(async (path) => {
    const peerPath = join(path, '..', 'peer.sqlite');
    for (const candidate of [path, peerPath]) new RealMealTestLedger(candidate).close();
    await run(path, peerPath);
  });
}

function seedFirstPasses(path, count, prefix) {
  const ledger = new RealMealTestLedger(path);
  try {
    for (let index = 0; index < count; index += 1) {
      const first = ledger.reserve({ ...base(`${prefix}-${index}`, 'whole'), validationRunId: `${prefix}-${Math.floor(index / 50)}` });
      if (index === 0) ledger.finish(first.attemptId, { elapsedMs: 180_000, httpStatus: 200, outcome: 'timeout' });
      else accepted(ledger, first.attemptId);
    }
    return ledger.attempts();
  } finally { ledger.close(); }
}

test('known live paths always include both historical ledgers, while memory and temporary paths stay isolated', async () => {
  for (const path of REAL_MEAL_LEDGER_PATHS) {
    assert.deepEqual(new Set(resolveRealMealLedgerPaths(path)), new Set(REAL_MEAL_LEDGER_PATHS));
    assert.equal(resolveRealMealLedgerPaths(path, { relatedLedgerPaths: [path, resolve(path, '..', '.', path.split(/[\\/]/).at(-1))] }).length, 2);
  }
  assert.deepEqual(resolveRealMealLedgerPaths(':memory:'), [':memory:']);
  await withLedger(async (path) => {
    assert.deepEqual(resolveRealMealLedgerPaths(path), [resolve(path)]);
    const ledger = new RealMealTestLedger(path);
    try { assert.equal(ledger.totals().totalRequests, 0); assert.equal(ledger.totals().ledgerCount, 1); }
    finally { ledger.close(); }
  });
});

test('a shared 4+51 history leaves 20 requests across both active paths, including failed attempts, without copying rows', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    const before = seedFirstPasses(path, 4, 'single-history');
    const peerBefore = seedFirstPasses(peerPath, 51, 'batch-history');
    const first = new RealMealTestLedger(path, { relatedLedgerPaths: [peerPath, path, resolve(peerPath, '..', '.', 'peer.sqlite')] });
    const second = new RealMealTestLedger(peerPath, { relatedLedgerPaths: [path, peerPath] });
    try {
      assert.equal(first.totals().totalRequests, 55);
      assert.equal(first.totals().localRequests, 4);
      assert.equal(first.totals().relatedRequests, 51);
      assert.equal(first.totals().remainingRequests, 20);
      assert.equal(first.totals().ledgerCount, 2);
      assert.equal(second.totals().totalRequests, 55);
      for (let index = 0; index < 20; index += 1) {
        const ledger = index % 2 ? second : first;
        const attempt = ledger.reserve({ ...base(`new-meal-${index}`, 'whole'), resultVersion: 3, validationRunId: 'new-nutrition-round' });
        if (index < 2) ledger.finish(attempt.attemptId, { elapsedMs: 180_000, httpStatus: 200, outcome: index === 0 ? 'timeout' : 'format_error' });
        else accepted(ledger, attempt.attemptId);
      }
      for (const ledger of [first, second]) {
        assert.equal(ledger.totals().totalRequests, 75);
        assert.equal(ledger.totals().remainingRequests, 0);
        assert.throws(() => ledger.reserve({ ...base('request-76', 'whole'), validationRunId: 'yet-another-round' }), /75-request/);
      }
      assert.equal(first.attempts().length, 14);
      assert.equal(second.attempts().length, 61);
      assert.deepEqual(first.attempts().slice(0, 4), before);
      assert.deepEqual(second.attempts().slice(0, 51), peerBefore);
      assert.equal(first.attemptsForRun('new-nutrition-round')[0].status, 'timeout');
      assert.equal(second.attemptsForRun('new-nutrition-round')[0].status, 'format_error');
    } finally { first.close(); second.close(); }
  });
});

test('switching the active ledger cannot reset the same run meal limit or stage order', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    const first = new RealMealTestLedger(path, { relatedLedgerPaths: [peerPath] });
    const second = new RealMealTestLedger(peerPath, { relatedLedgerPaths: [path] });
    try {
      const whole = first.reserve({ ...base('shared-meal', 'whole'), validationRunId: 'same-round' });
      accepted(first, whole.attemptId);
      assert.throws(() => second.reserve({ ...base('shared-meal', 'whole'), validationRunId: 'same-round' }), /already been attempted/);
      const review = second.reserve({ ...base('shared-meal', 'crop_review'), validationRunId: 'same-round' });
      accepted(second, review.attemptId);
      const merge = first.reserve({ ...base('shared-meal', 'final_merge'), validationRunId: 'same-round' });
      accepted(first, merge.attemptId);
      assert.throws(() => second.reserve({ ...base('shared-meal', 'whole'), validationRunId: 'same-round' }), /3-request per-meal/);
      const newRound = second.reserve({ ...base('shared-meal', 'whole'), validationRunId: 'next-round' });
      accepted(second, newRound.attemptId);
      assert.equal(first.totals().totalRequests, 4);
    } finally { first.close(); second.close(); }
  });
});

test('the 25-meal review limit includes failed reviews in both ledgers and resets only for a new run', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    const first = new RealMealTestLedger(path, { relatedLedgerPaths: [peerPath] });
    const second = new RealMealTestLedger(peerPath, { relatedLedgerPaths: [path] });
    try {
      for (let index = 0; index < 26; index += 1) {
        const whole = first.reserve({ ...base(`shared-review-${index}`, 'whole'), validationRunId: 'reviews-round' });
        accepted(first, whole.attemptId);
        if (index < 25) {
          const ledger = index % 2 ? second : first;
          const review = ledger.reserve({ ...base(`shared-review-${index}`, 'crop_review'), validationRunId: 'reviews-round' });
          if (index === 0) ledger.finish(review.attemptId, { elapsedMs: 20, outcome: 'request_error' });
          else accepted(ledger, review.attemptId);
        }
      }
      assert.throws(() => second.reserve({ ...base('shared-review-25', 'crop_review'), validationRunId: 'reviews-round' }), /25-meal additional-review/);
      const nextWhole = second.reserve({ ...base('shared-review-25', 'whole'), validationRunId: 'reviews-next-round' });
      accepted(second, nextWhole.attemptId);
      const nextReview = first.reserve({ ...base('shared-review-25', 'crop_review'), validationRunId: 'reviews-next-round' });
      accepted(first, nextReview.attemptId);
      assert.equal(first.totals().totalRequests, 53);
    } finally { first.close(); second.close(); }
  });
});

test('a missing shared-budget peer fails closed without creating a replacement ledger', async () => {
  await withLedger(async (path) => {
    const missing = join(path, '..', 'missing.sqlite');
    assert.throws(() => new RealMealTestLedger(path, { relatedLedgerPaths: [missing] }), /missing or unreadable/);
    await assert.rejects(access(path));
    await assert.rejects(access(missing));
  });
});

test('accepted completion cannot be recorded before the provider completed and business validation succeeded', () => {
  const ledger = new RealMealTestLedger(':memory:');
  try {
    const attempt = ledger.reserve({ ...base('unfinished', 'whole'), resultVersion: 3 });
    assert.throws(() => ledger.finish(attempt.attemptId, { elapsedMs: 10, providerCompleted: false, resultAccepted: true, outcome: 'accepted' }), /requires provider completion/);
    assert.throws(() => ledger.finish(attempt.attemptId, { elapsedMs: 10, httpStatus: 500, providerCompleted: true, resultAccepted: true, outcome: 'accepted' }), /successful HTTP status/);
    ledger.finish(attempt.attemptId, { elapsedMs: 10, outcome: 'timeout', errorName: 'TimeoutError', errorCode: 'https://private.invalid/credential' });
    assert.equal(ledger.attempts()[0].errorCode, null);
    assert.equal(ledger.attempts()[0].errorName, 'TimeoutError');
    assert.equal(ledger.totals().totalRequests, 1);
  } finally { ledger.close(); }
});

test('two concurrent writers sharing their final request slot cannot reserve request 76', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    seedFirstPasses(path, 37, 'concurrent-a');
    seedFirstPasses(peerPath, 37, 'concurrent-b');
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { RealMealTestLedger } = await import(workerData.moduleUrl);
        const ledger = new RealMealTestLedger(workerData.path, { relatedLedgerPaths: [workerData.peer] });
        parentPort.postMessage({ ready: true });
        parentPort.once('message', () => {
          try {
            ledger.reserve({ mealId: workerData.meal, validationRunId: 'concurrent-final-slot', stage: 'whole', model: 'gpt-6.1-sol', reasoningEffort: 'max', resultVersion: 3 });
            parentPort.postMessage({ reserved: true });
          } catch (error) { parentPort.postMessage({ reserved: false, error: error.message }); }
          finally { ledger.close(); parentPort.close(); }
        });
      })().catch((error) => { throw error; });
    `;
    const workers = [new Worker(source, { eval: true, workerData: { moduleUrl: new URL('./real-meal-test-ledger.mjs', import.meta.url).href, path, peer: peerPath, meal: 'concurrent-first' } }),
      new Worker(source, { eval: true, workerData: { moduleUrl: new URL('./real-meal-test-ledger.mjs', import.meta.url).href, path: peerPath, peer: path, meal: 'concurrent-second' } })];
    try {
      await Promise.all(workers.map((worker) => once(worker, 'message')));
      const outcomes = workers.map((worker) => once(worker, 'message'));
      for (const worker of workers) worker.postMessage('reserve');
      const results = (await Promise.all(outcomes)).map(([message]) => message);
      assert.equal(results.filter((result) => result.reserved).length, 1);
      assert.match(results.find((result) => !result.reserved).error, /75-request/);
      const ledger = new RealMealTestLedger(path, { relatedLedgerPaths: [peerPath] });
      try { assert.equal(ledger.totals().totalRequests, 75); } finally { ledger.close(); }
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  });
});

test('an abruptly terminated coordinator holder leaves no stale lock for the next reservation', async () => {
  await withTwoLedgers(async (path, peerPath) => {
    const coordinatorPath = resolveRealMealLedgerPaths(path, { relatedLedgerPaths: [peerPath] })[0];
    const holder = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.path);
      db.exec('BEGIN IMMEDIATE');
      parentPort.on('message', () => {});
      parentPort.postMessage('locked');
    `, { eval: true, workerData: { path: coordinatorPath } });
    try {
      assert.deepEqual(await once(holder, 'message'), ['locked']);
      await holder.terminate();
      const ledger = new RealMealTestLedger(peerPath, { relatedLedgerPaths: [path] });
      try {
        const attempt = ledger.reserve({ ...base('after-coordinator-crash', 'whole'), validationRunId: 'recovery-round' });
        accepted(ledger, attempt.attemptId);
        assert.equal(ledger.totals().totalRequests, 1);
      } finally { ledger.close(); }
    } finally { await holder.terminate(); }
  });
});
