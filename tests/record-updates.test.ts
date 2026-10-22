import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, type AppData } from '../src/types';
import { upsertMeal, upsertSleep, upsertTraining, upsertWorkoutTemplate } from '../src/record-updates';
import type { MealDraft, SleepDraft, TrainingDraft } from '../src/ui/app-types';

const meal = (foodName: string) => ({ foodName, mealType: 'lunch', occurredAt: '2026-10-23T04:00:00.000Z' }) as unknown as MealDraft;
const sleep = (fellAsleepAt: string, wokeAt: string) => ({ fellAsleepAt, wokeAt }) as unknown as SleepDraft;
const training = (exercise: string) => ({ exercise, occurredAt: '2026-10-23T04:00:00.000Z', sets: [] }) as unknown as TrainingDraft;

test('a new meal is prepended at revision 1 with its photo analysis versions', () => {
  const photo = { model: 'm', createdAt: 't', analysis: {}, history: [{ model: 'old', createdAt: 't0', analysis: {} }] } as never;
  const next = upsertMeal({ ...emptyData(), meals: [] }, meal('米饭'), undefined, photo);
  assert.equal(next.meals.length, 1);
  assert.equal(next.meals[0].revision, 1);
  assert.deepEqual(next.meals[0].analyses!.map((item) => [item.model, item.sourceVersion]), [['old', 1], ['m', 1]]);
});

test('editing a meal keeps id and createdAt, bumps the revision and snapshots the previous one', () => {
  const first = upsertMeal(emptyData(), meal('米饭'));
  const { id, createdAt } = first.meals[0];
  const second = upsertMeal(first, meal('面条'), id);
  const edited = second.meals[0];
  assert.equal(second.meals.length, 1);
  assert.equal(edited.id, id);
  assert.equal(edited.createdAt, createdAt);
  assert.equal(edited.foodName, '面条');
  assert.equal(edited.revision, 2);
  assert.equal(edited.revisions?.[0].foodName, '米饭');
  assert.equal('revisions' in edited.revisions![0], false);
  assert.throws(() => upsertMeal(second, meal('x'), 'missing'), /饮食记录已不存在/);
});

test('trainings and sleeps replace in place; duplicate sleep windows are rejected', () => {
  const withTraining = upsertTraining(emptyData(), training('深蹲'));
  const id = withTraining.trainings[0].id;
  const edited = upsertTraining(withTraining, training('卧推'), id);
  assert.equal(edited.trainings.length, 1);
  assert.equal(edited.trainings[0].exercise, '卧推');
  assert.ok(edited.trainings[0].updatedAt);
  assert.throws(() => upsertTraining(edited, training('x'), 'missing'), /训练记录已不存在/);

  const night = upsertSleep(emptyData(), sleep('a', 'b'));
  assert.throws(() => upsertSleep(night, sleep('a', 'b')), /相同入睡和起床时间/);
  const sameRecord = upsertSleep(night, sleep('a', 'b'), night.sleeps[0].id);
  assert.equal(sameRecord.sleeps.length, 1);
});

test('workout templates match names case-insensitively and keep their id', () => {
  const template = (name: string) => ({ name, exercises: [{ name: ' 深蹲 ', setCount: 3, weightUnit: 'kg' }] }) as never;
  const first: AppData = upsertWorkoutTemplate(emptyData(), template(' Push '));
  const second = upsertWorkoutTemplate(first, template('push'));
  assert.equal(second.workoutTemplates!.length, 1);
  assert.equal(second.workoutTemplates![0].id, first.workoutTemplates![0].id);
  assert.equal(second.workoutTemplates![0].name, 'push');
  assert.equal(second.workoutTemplates![0].exercises[0].name, '深蹲');
});
