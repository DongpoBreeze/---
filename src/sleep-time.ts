import { localDate } from './domain';

export const SLEEP_TIME_STEP_MINUTES = 5;
export type SleepTimeEndpoint = 'fell' | 'woke';
export type SleepTimeline = {
  axisStart: number;
  axisEnd: number;
  fellAt: number;
  wokeAt: number;
  hasFell: boolean;
  hasWoke: boolean;
  durationMinutes: number | null;
};

export function sleepClockLabel(value: number | Date) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function sleepLocalTimeLabel(value: number | Date) {
  return `${localDate(new Date(value))} ${sleepClockLabel(value)}`;
}

/** Reject normalized dates, including nonexistent calendar days or local times. */
export function parseSleepLocalTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const date = new Date(value.replace(' ', 'T') + ':00');
  return Number.isFinite(date.getTime()) && sleepLocalTimeLabel(date) === value ? date : null;
}

/** Empty fields get slider suggestions only; building the timeline never fills the form. */
export function buildSleepTimeline(fell: string, woke: string, reference = new Date()): SleepTimeline {
  const parsedFell = parseSleepLocalTime(fell);
  const parsedWoke = parseSleepLocalTime(woke);
  const rawDuration = parsedFell && parsedWoke ? (parsedWoke.getTime() - parsedFell.getTime()) / 60000 : null;
  const durationMinutes = rawDuration !== null && rawDuration > 0 && rawDuration <= 1440 ? rawDuration : null;
  let fellAt: Date;
  let wokeAt: Date;
  if (parsedFell && parsedWoke) {
    fellAt = parsedFell;
    wokeAt = parsedWoke;
  } else if (parsedFell) {
    fellAt = parsedFell;
    wokeAt = new Date(fellAt);
    wokeAt.setHours(7, 0, 0, 0);
    if (wokeAt <= fellAt) wokeAt.setDate(wokeAt.getDate() + 1);
  } else if (parsedWoke) {
    wokeAt = parsedWoke;
    fellAt = new Date(wokeAt);
    fellAt.setHours(23, 0, 0, 0);
    if (fellAt >= wokeAt) fellAt.setDate(fellAt.getDate() - 1);
  } else {
    wokeAt = new Date(reference);
    wokeAt.setHours(7, 0, 0, 0);
    fellAt = new Date(wokeAt);
    fellAt.setDate(fellAt.getDate() - 1);
    fellAt.setHours(23, 0, 0, 0);
  }
  const axisStart = new Date(wokeAt);
  axisStart.setDate(axisStart.getDate() - 1);
  axisStart.setHours(18, 0, 0, 0);
  const axisEnd = new Date(wokeAt);
  axisEnd.setHours(12, 0, 0, 0);
  // Daytime or long sleep remains editable without clipping or changing its dates.
  if (fellAt < axisStart || wokeAt > axisEnd || fellAt >= wokeAt) {
    axisStart.setTime(Math.min(fellAt.getTime(), wokeAt.getTime()));
    axisStart.setHours(Math.floor(axisStart.getHours() / 3) * 3, 0, 0, 0);
    axisEnd.setTime(Math.max(fellAt.getTime(), wokeAt.getTime()));
    const roundedHour = Math.ceil((axisEnd.getHours() * 60 + axisEnd.getMinutes()) / 180) * 3;
    axisEnd.setHours(roundedHour, 0, 0, 0);
  }
  // Identical endpoints on an exact tick still need a nonzero editable scale.
  if (axisEnd <= axisStart) axisEnd.setTime(axisStart.getTime() + 180 * 60000);
  return {
    axisStart: axisStart.getTime(), axisEnd: axisEnd.getTime(),
    fellAt: fellAt.getTime(), wokeAt: wokeAt.getTime(),
    hasFell: parsedFell !== null, hasWoke: parsedWoke !== null, durationMinutes,
  };
}

export function sleepTimelineTicks(model: Pick<SleepTimeline, 'axisStart' | 'axisEnd'>) {
  const ticks: Array<{ label: string; ratio: number }> = [];
  const spanHours = (model.axisEnd - model.axisStart) / 3600000;
  const stepHours = Math.max(3, Math.ceil(spanHours / 21) * 3);
  const time = new Date(model.axisStart);
  while (time.getTime() <= model.axisEnd && ticks.length < 8) {
    ticks.push({ label: sleepClockLabel(time), ratio: (time.getTime() - model.axisStart) / (model.axisEnd - model.axisStart) });
    time.setHours(time.getHours() + stepHours, 0, 0, 0);
  }
  if (ticks.at(-1)?.ratio !== 1) ticks.push({ label: sleepClockLabel(model.axisEnd), ratio: 1 });
  return ticks;
}

/** Moving one handle preserves the other and cannot cross it or leave the visible axis. */
export function moveSleepTimeline(model: SleepTimeline, endpoint: SleepTimeEndpoint, offsetMinutes: number) {
  if (!Number.isFinite(offsetMinutes)) throw new Error('请选择有效时间。');
  const minutes = (model.axisEnd - model.axisStart) / 60000;
  const snapped = Math.round(offsetMinutes / SLEEP_TIME_STEP_MINUTES) * SLEEP_TIME_STEP_MINUTES;
  const fellOffset = (model.fellAt - model.axisStart) / 60000;
  const wokeOffset = (model.wokeAt - model.axisStart) / 60000;
  const next = endpoint === 'fell'
    ? Math.max(0, Math.min(wokeOffset - 1, snapped))
    : Math.min(minutes, Math.max(fellOffset + 1, snapped));
  return {
    fell: sleepLocalTimeLabel(endpoint === 'fell' ? model.axisStart + next * 60000 : model.fellAt),
    woke: sleepLocalTimeLabel(endpoint === 'woke' ? model.axisStart + next * 60000 : model.wokeAt),
  };
}
