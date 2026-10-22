export const MAX_MEAL_PHOTOS = 4;

type BeforeMealPhotos = { imageUri?: string; beforeImageUris?: string[] };
type MealPhotos = BeforeMealPhotos & { afterImageUri?: string };

/** Keep the legacy primary first and never count its array mirror twice. */
export function mealBeforePhotoUris(input: BeforeMealPhotos): string[] {
  const candidates = [input.imageUri, ...(Array.isArray(input.beforeImageUris) ? input.beforeImageUris : [])];
  return [...new Set(candidates.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0))];
}

/** Restore media deletions lost when JSON omits undefined aliases in form drafts. */
export function normalizeMealPhotoDraft<T>(draft: T): T {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return draft;
  const photos = draft as MealPhotos;
  if (Object.hasOwn(draft, 'beforeImageUris')) {
    // A new-format before list is the complete media snapshot. Its first entry
    // owns the primary alias; missing after media means it was removed.
    const sources = mealAnalysisPhotoSources({ beforeImageUris: photos.beforeImageUris, afterImageUri: photos.afterImageUri });
    const beforeImageUris = sources.filter((source) => source.role === 'before').map((source) => source.uri);
    return { ...draft, beforeImageUris, imageUri: beforeImageUris[0], afterImageUri: photos.afterImageUri };
  }
  if (Object.hasOwn(draft, 'imageUri')) {
    // An old single-photo draft must not inherit a newer record's photo list.
    return { ...draft, beforeImageUris: mealBeforePhotoUris({ imageUri: photos.imageUri }) };
  }
  return draft;
}

/** Validate the complete source set before preprocessing or starting a request. */
export function mealAnalysisPhotoSources(input: MealPhotos): { role: 'before' | 'after'; uri: string }[] {
  if (input.beforeImageUris !== undefined && (!Array.isArray(input.beforeImageUris) || input.beforeImageUris.length > MAX_MEAL_PHOTOS
    || Array.from(input.beforeImageUris).some((uri) => typeof uri !== 'string' || !uri.length))) {
    throw new Error(`餐前照片必须是最多 ${MAX_MEAL_PHOTOS} 张原图的列表。`);
  }
  for (const uri of [input.imageUri, input.afterImageUri, ...(input.beforeImageUris ?? [])]) {
    if (uri !== undefined && (typeof uri !== 'string' || !uri.length)) throw new Error('餐食照片地址无效，请重新选择。');
  }
  const sources = mealBeforePhotoUris(input).map((uri) => ({ role: 'before' as const, uri }));
  const result = [...sources, ...(input.afterImageUri ? [{ role: 'after' as const, uri: input.afterImageUri }] : [])];
  if (result.length > MAX_MEAL_PHOTOS) throw new Error(`每餐最多 ${MAX_MEAL_PHOTOS} 张照片，已有餐后照片也计入上限。`);
  return result;
}

/** Regions have no image index. Only the legacy single-before pair is unambiguous. */
export function canCropMealPhotoRegions(photoCount: number, roles: unknown): boolean {
  if (photoCount <= 1) return true;
  return photoCount === 2 && Array.isArray(roles) && roles.length === 2
    && roles.filter((role) => role === 'before').length === 1
    && roles.filter((role) => role === 'after').length === 1;
}
