import type { MealRegion } from '../src/types';

export type MealReviewDecision = { stage: 'crop_review' | 'final_merge'; reasons: string[]; componentIndices: number[]; regions: MealRegion[] };
export function decideMealReview(initial: unknown, review?: unknown, hasPhotos?: boolean, allowUncertainIdentityChanges?: boolean): MealReviewDecision | null;
