import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultMealTypeForHour, defaultMealTypeForNow } from '../src/meal-time';

test('default meal slot follows local eating windows', () => {
  const cases: Array<[number, string]> = [
    [0, '加餐'], [4, '加餐'], [5, '早餐'], [10, '早餐'],
    [11, '午餐'], [14, '午餐'], [15, '加餐'], [16, '加餐'],
    [17, '晚餐'], [21, '晚餐'], [22, '加餐'], [23, '加餐'],
  ];
  for (const [hour, expected] of cases) assert.equal(defaultMealTypeForHour(hour), expected, `${hour}:00`);
});

test('default meal slot uses the Date local hour', () => {
  const original = Date.prototype.getHours;
  try {
    Date.prototype.getHours = () => 12;
    assert.equal(defaultMealTypeForNow(new Date('2026-10-27T00:00:00.000Z')), '午餐');
  } finally {
    Date.prototype.getHours = original;
  }
});
