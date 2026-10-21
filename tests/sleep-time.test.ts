import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSleepTimeline, moveSleepTimeline, parseSleepLocalTime, sleepLocalTimeLabel, sleepTimelineTicks } from '../src/sleep-time';

test('empty sleep fields stay unconfirmed while the slider offers a cross-midnight range', () => {
  const model = buildSleepTimeline('', '', new Date(2026, 9, 21, 17));
  assert.equal(model.durationMinutes, null);
  assert.equal(model.hasFell, false);
  assert.equal(model.hasWoke, false);
  assert.equal(sleepLocalTimeLabel(model.fellAt), '2026-10-20 23:00');
  assert.equal(sleepLocalTimeLabel(model.wokeAt), '2026-10-21 07:00');
  assert.equal(sleepLocalTimeLabel(model.axisStart), '2026-10-20 18:00');
  assert.equal(sleepLocalTimeLabel(model.axisEnd), '2026-10-21 12:00');
});

test('evening and morning nine oclock ticks use their actual locations on the night axis', () => {
  const ticks = sleepTimelineTicks(buildSleepTimeline('2026-10-20 23:30', '2026-10-21 07:00'));
  assert.equal(ticks.find((tick) => tick.label === '21:00')?.ratio, 1 / 6);
  assert.equal(ticks.find((tick) => tick.label === '09:00')?.ratio, 5 / 6);
  assert.equal(ticks.at(-1)?.ratio, 1);
});

test('dragging to evening nine and morning nine updates dates and preserves the other endpoint', () => {
  const model = buildSleepTimeline('2026-10-20 23:30', '2026-10-21 07:00');
  const first = moveSleepTimeline(model, 'fell', 180);
  assert.deepEqual(first, { fell: '2026-10-20 21:00', woke: '2026-10-21 07:00' });
  const second = moveSleepTimeline(buildSleepTimeline(first.fell, first.woke), 'woke', 900);
  assert.deepEqual(second, { fell: '2026-10-20 21:00', woke: '2026-10-21 09:00' });
  assert.equal(buildSleepTimeline(second.fell, second.woke).durationMinutes, 720);
});

test('slider snaps in five-minute steps and clamps before the handles cross', () => {
  const model = buildSleepTimeline('2026-10-20 23:30', '2026-10-21 07:00');
  assert.equal(moveSleepTimeline(model, 'fell', 182).fell, '2026-10-20 21:00');
  assert.equal(moveSleepTimeline(model, 'fell', -500).fell, '2026-10-20 18:00');
  assert.equal(moveSleepTimeline(model, 'woke', 9999).woke, '2026-10-21 12:00');
  const lateStart = moveSleepTimeline(model, 'fell', 9999);
  assert.equal(buildSleepTimeline(lateStart.fell, lateStart.woke).durationMinutes, 1);
  const earlyEnd = moveSleepTimeline(model, 'woke', -9999);
  assert.equal(buildSleepTimeline(earlyEnd.fell, earlyEnd.woke).durationMinutes, 1);
  assert.throws(() => moveSleepTimeline(model, 'fell', NaN));
});

test('picker or typed minute-precise times remain exact until that endpoint is moved', () => {
  const model = buildSleepTimeline('2026-10-20 23:17', '2026-10-21 07:42');
  assert.equal(model.durationMinutes, 505);
  assert.equal(moveSleepTimeline(model, 'fell', 300).woke, '2026-10-21 07:42');
  assert.equal(moveSleepTimeline(model, 'woke', 900).fell, '2026-10-20 23:17');
});

test('partial inputs retain their selected date across month and year boundaries', () => {
  const fellOnly = buildSleepTimeline('2026-12-31 23:30', '');
  assert.equal(sleepLocalTimeLabel(fellOnly.wokeAt), '2027-01-01 07:00');
  assert.equal(fellOnly.durationMinutes, null);
  const wokeOnly = buildSleepTimeline('', '2026-03-01 07:00');
  assert.equal(sleepLocalTimeLabel(wokeOnly.fellAt), '2026-02-28 23:00');
});

test('daytime sleep expands the visible axis without clipping the original times', () => {
  const model = buildSleepTimeline('2026-10-21 13:15', '2026-10-21 16:20');
  assert.equal(model.durationMinutes, 185);
  assert.equal(sleepLocalTimeLabel(model.axisStart), '2026-10-21 12:00');
  assert.equal(sleepLocalTimeLabel(model.axisEnd), '2026-10-21 18:00');
  assert.equal(moveSleepTimeline(model, 'fell', 60).woke, '2026-10-21 16:20');
});

test('invalid dates and reversed or excessive sleep durations do not become confirmed data', () => {
  for (const value of ['2026-02-29 23:00', '2026-10-21 24:00', '2026-10-21 07:60', '', '2026-10-21T07:00']) {
    assert.equal(parseSleepLocalTime(value), null);
  }
  for (const [fell, woke] of [
    ['2026-10-21 23:30', '2026-10-21 07:00'],
    ['2026-10-20 07:00', '2026-10-21 07:01'],
    ['2026-10-21 07:00', '2026-10-21 07:00'],
  ]) {
    const model = buildSleepTimeline(fell, woke);
    assert.equal(model.durationMinutes, null);
    assert.ok(model.axisEnd > model.axisStart);
    assert.ok(sleepTimelineTicks(model).every((tick) => Number.isFinite(tick.ratio)));
  }
  const coincidentTick = buildSleepTimeline('2026-10-21 06:00', '2026-10-21 06:00');
  assert.ok(coincidentTick.axisEnd > coincidentTick.axisStart);
  assert.ok(sleepTimelineTicks(coincidentTick).every((tick) => Number.isFinite(tick.ratio)));
});

test('local date boundaries and DST use actual elapsed time rather than an assumed eighteen hours', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const model = buildSleepTimeline('2026-03-07 23:30', '2026-03-08 07:00');
    assert.equal(model.durationMinutes, 390);
    assert.equal((model.axisEnd - model.axisStart) / 3600000, 17);
    assert.equal(sleepLocalTimeLabel(model.axisStart), '2026-03-07 18:00');
    assert.equal(sleepLocalTimeLabel(model.axisEnd), '2026-03-08 12:00');
    assert.equal(parseSleepLocalTime('2026-03-08 02:30'), null);
    assert.equal(moveSleepTimeline(model, 'woke', 840).woke, '2026-03-08 09:00');
    assert.ok(sleepTimelineTicks(model).some((tick) => tick.label === '09:00'));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
