import type { AppData, MealRecord, SleepRecord, TrainingRecord, WorkoutTemplate } from './types';
import type { MealDraft, PhotoAnalysisResult, SleepDraft, TrainingDraft } from './ui/app-types';
import { uid } from './domain';

type Collection = 'meals' | 'trainings' | 'sleeps';
type RecordOf<C extends Collection> = AppData[C][number];

/** Insert a new record at the front, or replace an existing one keeping its id and createdAt. */
function upsert<C extends Collection>(
  current: AppData,
  collection: C,
  missing: string,
  id: string | undefined,
  create: () => RecordOf<C>,
  update: (old: RecordOf<C>) => RecordOf<C>,
): AppData {
  const list = current[collection] as RecordOf<C>[];
  if (!id) return { ...current, [collection]: [create(), ...list] };
  const old = list.find((item) => item.id === id);
  if (!old) throw new Error(missing);
  const item = update(old);
  return { ...current, [collection]: list.map((value) => (value.id === id ? item : value)) };
}

/** Meals keep every previous revision and the analyses produced for each one. */
export function upsertMeal(current: AppData, draft: MealDraft, id?: string, photoAnalysis?: PhotoAnalysisResult): AppData {
  const photoVersions = (sourceVersion: number) => {
    if (!photoAnalysis) return [];
    const { history, ...latest } = photoAnalysis;
    return [...(history ?? []), latest].map((version) => ({ id: uid(), ...version, sourceVersion }));
  };
  return upsert(current, 'meals', '这条饮食记录已不存在', id,
    (): MealRecord => ({
      ...draft, id: uid(), type: 'meal', createdAt: new Date().toISOString(), revision: 1,
      analyses: photoAnalysis ? photoVersions(1) : undefined,
    }),
    (old) => {
      const { revisions: previousRevisions, ...snapshot } = old;
      const revision = (old.revision ?? 1) + 1;
      return {
        ...old, ...draft, id: old.id, type: 'meal', createdAt: old.createdAt, revision,
        updatedAt: new Date().toISOString(),
        revisions: [...(previousRevisions ?? []), snapshot],
        analyses: photoAnalysis ? [...(old.analyses ?? []), ...photoVersions(revision)] : old.analyses,
      };
    });
}

export function upsertTraining(current: AppData, draft: TrainingDraft, id?: string): AppData {
  return upsert(current, 'trainings', '这条训练记录已不存在', id,
    (): TrainingRecord => ({ ...draft, id: uid(), type: 'training', createdAt: new Date().toISOString() }),
    (old) => ({ ...old, ...draft, id: old.id, type: 'training', createdAt: old.createdAt, updatedAt: new Date().toISOString() }));
}

export function upsertSleep(current: AppData, draft: SleepDraft, id?: string): AppData {
  if (current.sleeps.some((record) => record.id !== id && record.fellAsleepAt === draft.fellAsleepAt && record.wokeAt === draft.wokeAt))
    throw new Error('已经有相同入睡和起床时间的睡眠记录。请打开原记录修改。');
  return upsert(current, 'sleeps', '这条睡眠记录已不存在', id,
    (): SleepRecord => ({ ...draft, id: uid(), type: 'sleep', createdAt: new Date().toISOString() }),
    (old) => ({ ...old, ...draft, id: old.id, type: 'sleep', createdAt: old.createdAt, updatedAt: new Date().toISOString() }));
}

/** Templates are matched by case-insensitive name; saving an existing name replaces it in place. */
export function upsertWorkoutTemplate(current: AppData, template: Omit<WorkoutTemplate, 'id'>): AppData {
  const templates = current.workoutTemplates ?? [];
  const key = template.name.trim().toLocaleLowerCase();
  const index = templates.findIndex((item) => item.name.trim().toLocaleLowerCase() === key);
  const saved: WorkoutTemplate = {
    ...template,
    name: template.name.trim(),
    exercises: template.exercises.map((item) => ({ ...item, name: item.name.trim() })),
    id: index < 0 ? uid() : templates[index].id,
  };
  const workoutTemplates = index < 0 ? [...templates, saved] : templates.map((item, itemIndex) => itemIndex === index ? saved : item);
  return { ...current, workoutTemplates };
}
