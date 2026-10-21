import type {
  AnalysisVersion,
  MealAnalysis,
  MealRecord,
  SleepRecord,
  TrainingRecord,
} from "../types";

export type Tab = "today" | "records" | "trends" | "me";
export type Kind = "meal" | "training" | "sleep";
export type ModalKind = Kind | "profile" | "ai-settings" | null;
export type DraftKey = "meal-new" | "training-new" | "sleep-new" | string;
export type MealDraft = Omit<
  MealRecord,
  | "id"
  | "type"
  | "createdAt"
  | "revision"
  | "updatedAt"
  | "revisions"
  | "analyses"
>;
export type PhotoAnalysisSnapshot = Pick<AnalysisVersion, "model" | "createdAt" | "stageCount" | "analysis">;
export type PhotoAnalysisResult = PhotoAnalysisSnapshot & {
  /** Earlier model responses and user revisions from the confirmation flow. */
  history?: PhotoAnalysisSnapshot[];
};
export type TrainingDraft = Omit<
  TrainingRecord,
  "id" | "type" | "createdAt" | "updatedAt"
>;
export type SleepDraft = Omit<SleepRecord, "id" | "type" | "createdAt" | "updatedAt">;
export type SaveNutritionCorrection = (
  mealId: string,
  revision: number,
  baseAnalysisId: string,
  analysis: MealAnalysis,
) => Promise<void>;
