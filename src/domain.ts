import { AppData, DailySummary, MealRecord, SleepRecord, TrainingExercise, TrainingRecord } from './types';

export function localDate(value: string | Date = new Date()): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function recordLocalDate(record: MealRecord | TrainingRecord | SleepRecord): string {
  const value = record.type === 'sleep' ? record.wokeAt : record.occurredAt;
  if (!record.timezone) return localDate(value);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: record.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function sleepStats(record: Pick<SleepRecord, 'fellAsleepAt' | 'wokeAt' | 'awakeMinutes'>) {
  const intervalMinutes = (Date.parse(record.wokeAt) - Date.parse(record.fellAsleepAt)) / 60000;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 1440) throw new Error('睡眠时间区间应大于 0 且不超过 24 小时');
  const awake = record.awakeMinutes;
  if (awake !== null && (!Number.isFinite(awake) || awake < 0 || awake > intervalMinutes)) throw new Error('清醒时长不能超过睡眠时间区间');
  // Missing optional waking time does not invalidate the entered sleep interval.
  // Keep the raw null in storage; subtract waking minutes only when supplied.
  return { intervalMinutes, asleepMinutes: intervalMinutes - (awake ?? 0) };
}

export function parseSleepTimes(date: string, start: string, end: string): { fellAsleepAt: string; wokeAt: string } {
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !clock.test(start) || !clock.test(end)) throw new Error('日期和时间格式不正确，请使用 YYYY-MM-DD 和 HH:mm');
  const wake = new Date(`${date}T${end}:00`);
  const sleep = new Date(`${date}T${start}:00`);
  if (!Number.isFinite(wake.getTime()) || localDate(wake) !== date) throw new Error('日期不存在');
  if (sleep >= wake) sleep.setDate(sleep.getDate() - 1);
  if (start === end) throw new Error('入睡与起床时间不能相同');
  return { fellAsleepAt: sleep.toISOString(), wokeAt: wake.toISOString() };
}

/** Per-exercise view of a session; legacy records become a single exercise named after the record. */
export function trainingExercises(record: Pick<TrainingRecord, 'exercise' | 'sets' | 'exercises'>): TrainingExercise[] {
  return record.exercises?.length ? record.exercises : [{ name: record.exercise, sets: record.sets }];
}

const setsText = (sets: TrainingExercise['sets']) => sets.map((s) => `${s.isWarmup ? '热身' : '工作组'} ${s.weight} ${s.unit} × ${s.reps} 次`).join('，');

export function trainingAdvice(record: TrainingRecord, history: TrainingRecord[]): string {
  if (record.mode === 'cardio') return `已完成 ${record.durationMinutes ?? 0} 分钟${record.exercise}。根据身体感受安排恢复。`;
  if (record.pain === 'yes') return '记录了疼痛，暂停增加负荷，先评估不适原因。';
  if (record.controlled === 'no' || record.rir === '0' || record.rir === '1') return '本次动作控制或余力不足，暂不增加重量和次数。';
  if ((record.exercises?.length ?? 0) > 1) {
    const work = record.sets.filter((s) => !s.isWarmup).length;
    return `本次完成 ${record.exercises!.length} 个动作、${work} 个工作组。动作稳定、余力充足时再逐个动作小幅加重。`;
  }
  const { targetSets, targetMin, targetMax, increment } = record;
  if (!targetSets || !targetMin || !targetMax || !increment || targetMin > targetMax || increment <= 0 || !record.weightBasis || record.weightBasis === 'bodyweight') return '补充目标组数、次数区间和最小加重后，再提供进阶参考。';
  if (record.pain !== 'no' || record.controlled !== 'yes' || !['2', '3', '4+'].includes(record.rir)) return '补充疼痛、动作控制与剩余次数反馈后，再提供进阶参考。';
  const work = record.sets.filter((s) => !s.isWarmup);
  if (work.length !== targetSets || !work.length || work.some((s) => !Number.isFinite(s.weight) || s.weight <= 0 || !Number.isInteger(s.reps) || s.reps <= 0 || s.weight !== work[0].weight || s.unit !== work[0].unit)) return '工作组数量或重量不一致，暂不提供进阶建议。';
  const previous = previousTraining(record, history);
  const prevWork = previous?.sets.filter((s) => !s.isWarmup);
  if (!previous || previous.targetSets !== targetSets || previous.weightBasis !== record.weightBasis || prevWork?.length !== targetSets || prevWork.some((s) => s.weight !== work[0].weight || s.unit !== work[0].unit)) return '还没有可比较的同动作、同重量、同目标组数记录，先保持当前记录。';
  if (work.every((s) => s.reps >= targetMax)) return `全部工作组达标，下次可尝试 ${work[0].weight + increment} ${work[0].unit}，增加 ${increment} ${work[0].unit}。`;
  return `保持 ${work[0].weight} ${work[0].unit}，下次可尝试 ${work.map((s) => Math.min(s.reps + 1, targetMax)).join('/')} 次。`;
}

function previousTraining(record: TrainingRecord, history: TrainingRecord[]): TrainingRecord | undefined {
  return history.filter((r) => r.id !== record.id && r.exercise.trim() === record.exercise.trim() && Date.parse(r.occurredAt) < Date.parse(record.occurredAt)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
}

export function mealCalories(meal: MealRecord): { min: number; max: number } | null {
  if (meal.estimate && meal.estimateStatus === 'estimated') return { min: meal.estimate.calories, max: meal.estimate.calories };
  const analysis = meal.analyses?.at(-1);
  if (analysis && analysis.sourceVersion === (meal.revision ?? 1)
    && (analysis.analysis.status === 'estimated'
      || (analysis.analysis.status === 'approximate' && (analysis.analysis.coverage?.counted ?? 0) > 0))) return analysis.analysis.calories;
  return null;
}

export function summaryMarkdown(data: AppData, date = localDate()): string {
  const meals = data.meals.filter((r) => recordLocalDate(r) === date);
  const training = data.trainings.filter((r) => recordLocalDate(r) === date);
  const sleep = data.sleeps.filter((r) => recordLocalDate(r) === date);
  const known = meals.map(mealCalories).filter((v) => v !== null);
  const partial = meals.filter((meal) => {
    const version = meal.analyses?.at(-1);
    const analysis = version?.sourceVersion === (meal.revision ?? 1) ? version.analysis : undefined;
    return ['user-quantity-v2', 'ai-per100g-v3', 'reference-quantity-v1'].includes(analysis?.nutritionSource?.method ?? '')
      && ((analysis?.coverage?.missingQuantityLabels?.length ?? 0) > 0 || (analysis?.coverage?.unknownNutritionLabels?.length ?? 0) > 0);
  });
  const min = known.reduce((sum, r) => sum + r.min, 0);
  const max = known.reduce((sum, r) => sum + r.max, 0);
  const lines = [
    `# ${date} 健康摘要`, '', '## 饮食',
    meals.length ? `${meals.length} 餐，${known.length ? `已填写菜品小计 ${Math.floor(min)}～${Math.ceil(max)} kcal` : '热量未记录'}。${meals.length > known.length ? ` ${meals.length - known.length} 餐未记录热量或可计算的食用量。` : ''}${partial.length ? ` ${partial.length} 餐数据不完整，有菜品缺少实际食用数量或有效营养参考。` : ''}` : '未记录',
    ...meals.map((r) => {
      const version = r.analyses?.at(-1);
      const analysis = version?.sourceVersion === (r.revision ?? 1) ? version.analysis : undefined;
      const missing = ['user-quantity-v2', 'ai-per100g-v3', 'reference-quantity-v1'].includes(analysis?.nutritionSource?.method ?? '')
        ? [...new Set([...(analysis?.coverage?.missingQuantityLabels ?? []), ...(analysis?.coverage?.unknownNutritionLabels ?? [])])] : [];
      return [`- ${r.mealType}：${r.foodName}${r.portion ? ` ${r.portion}` : ''}`,
        ...(missing.length ? [`未计入：${missing.join('、')}`] : []),
        ...(r.remaining ? [`剩余：${r.remaining}`] : []),
        ...(r.note ? [`备注：${r.note}`] : [])].join('；');
    }),
    '', '## 训练',
    ...(training.length ? training.map((r) => [
      `- ${r.exercise}：${r.mode === 'cardio' ? `${r.durationMinutes} 分钟` : (r.exercises?.length ?? 0) > 1 ? r.exercises!.map((e) => `${e.name}（${setsText(e.sets)}）`).join('；') : setsText(r.sets)}`,
      ...(r.pain === 'unknown' ? [] : [`疼痛：${r.pain === 'yes' ? '有' : '无'}`]),
      ...(r.controlled === 'unknown' ? [] : [`动作可控：${r.controlled === 'yes' ? '是' : '否'}`]),
      ...(r.rir === 'unknown' ? [] : [`最少剩余次数：${r.rir}`]),
      ...(r.note ? [`备注：${r.note}`] : []),
    ].join('；') + `\n  训练参考：${trainingAdvice(r, data.trainings)}`) : ['未记录']),
    '', '## 睡眠',
    ...(sleep.length ? sleep.map((r) => {
      const s = sleepStats(r);
      return [`- 时间区间 ${(s.intervalMinutes / 60).toFixed(1)} 小时`, `估算睡眠 ${(s.asleepMinutes / 60).toFixed(1)} 小时`,
        ...(r.awakeMinutes === null ? [] : [`清醒 ${r.awakeMinutes} 分钟`]),
        ...(r.quality === undefined ? [] : [`主观质量 ${r.quality}/5`]),
        ...(r.note ? [`备注：${r.note}`] : [])].join('；');
    }) : ['未记录']),
    '', '## 今日关注',
    training.some((r) => r.pain === 'yes') ? '训练时有疼痛，暂停增加负荷，先评估不适原因。' : meals.length + training.length + sleep.length === 0 ? '今天暂无记录。' : meals.length && !known.length ? '补充餐食份量，帮助判断实际摄入。' : !sleep.length ? '补充睡眠记录，回顾休息是否充足。' : '根据身体感受安排饮食、活动与休息。',
    '', '来源：本地记录与规则整理。',
  ];
  return lines.join('\n');
}

export function summaryInputSnapshot(data: AppData, date: string): NonNullable<DailySummary['inputSnapshot']> {
  const records = [...data.meals, ...data.trainings, ...data.sleeps].filter((record) => recordLocalDate(record) === date);
  for (const record of [...records]) {
    if (record.type !== 'training' || record.mode === 'cardio') continue;
    const previous = previousTraining(record, data.trainings);
    if (previous && !records.some((item) => item.id === previous.id)) records.push(previous);
  }
  return {
    date,
    profile: { ...data.profile },
    summary: summaryMarkdown(data, date),
    recordVersions: records.map((record) => ({ id: record.id, version: record.type === 'meal' ? String(record.revision ?? 1) : record.updatedAt ?? record.createdAt })),
  };
}

export function refreshSummaries(data: AppData, now = new Date()): AppData {
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const dates = new Set([localDate(now), localDate(yesterday), ...data.meals.map(recordLocalDate), ...data.trainings.map(recordLocalDate), ...data.sleeps.map(recordLocalDate)]);
  const ai = data.summaries.filter((r) => r.source === 'ai').map((r): DailySummary => ({ ...r, status: r.sourceVersion === data.sourceVersion ? r.status : 'stale' }));
  return { ...data, summaries: [...ai, ...Array.from(dates, (date): DailySummary => ({ id: `local-${date}`, date, markdown: summaryMarkdown(data, date), sourceVersion: data.sourceVersion, source: 'local', status: 'current', createdAt: now.toISOString() }))] };
}

export function removeRecord(data: AppData, type: 'meal' | 'training' | 'sleep', recordId: string): AppData {
  const drafts = data.drafts ? { ...data.drafts } : undefined;
  if (drafts?.[type]?.id === recordId) delete drafts[type];
  return refreshSummaries({ ...data, ...(drafts ? { drafts } : {}), meals: type === 'meal' ? data.meals.filter((r) => r.id !== recordId) : data.meals, trainings: type === 'training' ? data.trainings.filter((r) => r.id !== recordId) : data.trainings, sleeps: type === 'sleep' ? data.sleeps.filter((r) => r.id !== recordId) : data.sleeps, summaries: data.summaries.filter((s) => s.source !== 'ai' || (s.sourceRecordIds && !s.sourceRecordIds.includes(recordId) && !s.inputSnapshot?.recordVersions.some((r) => r.id === recordId))), sourceVersion: data.sourceVersion + 1 });
}
