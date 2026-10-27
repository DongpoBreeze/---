import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Image, Platform } from 'react-native';
import { z } from 'zod';
import { AppData, DailySummary, MealAnalysis, MealRecord, Profile } from './types';
import { summaryInputSnapshot } from './domain';
import { mealAnalysisSchema } from './nutrition-schema';
import { DAILY_SUMMARY_TIMEOUT_MS, MEAL_ANALYSIS_STAGE_TIMEOUT_MS, MAX_MEAL_ANALYSIS_STAGES, requestProvider } from './ai-provider';
import { canCropMealPhotoRegions, mealAnalysisPhotoSources } from './meal-photos';
import { getAiSettings, beginAiSettingsRequest } from './ai-settings';
export { loadAiSettings, saveAiSettings, clearAiSettings, getAiSettings, getAiSettingsVersion } from './ai-settings';
export { discoverModels, discoverModel, testAiConnection, normalizeConnection, validateAiSettings } from './ai-provider';
export type { AiConnection, AiSettings, AiModel } from './ai-provider';

const responseSchema = z.object({ analysis: z.unknown(), model: z.string(), createdAt: z.string().datetime(), stageCount: z.number().int().min(1).max(3).optional() });

export const MEAL_ANALYSIS_IMAGE_MAX_SIDE = 1200;
export const MEAL_ANALYSIS_IMAGE_COMPRESSION = 0.75;
export const MEAL_ANALYSIS_IMAGE_CONCURRENCY = 2;

function mealImageResizeAction(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('照片尺寸无法读取，请重新选择。');
  const longestSide = Math.min(Math.max(width, height), MEAL_ANALYSIS_IMAGE_MAX_SIDE);
  return { resize: width >= height ? { width: longestSide } : { height: longestSide } };
}

export const isAiConfigured = () => Boolean(getAiSettings());

export async function analyzeMeal(meal: MealRecord, _profile: Profile, signal?: AbortSignal, _requestId?: string): Promise<{ analysis: MealAnalysis; model: string; createdAt: string; stageCount?: number }> {
  const request = beginAiSettingsRequest(signal, MEAL_ANALYSIS_STAGE_TIMEOUT_MS * MAX_MEAL_ANALYSIS_STAGES + 5_000);
  const sourcePhotos: { role: string; uri: string; width: number; height: number }[] = [];
  const temporaryUris: string[] = [];
  try {
    request.assertCurrent();
    const inputs = mealAnalysisPhotoSources(meal);
    const processed: Array<{ role: string; photo: string; uri: string; width: number; height: number } | undefined> = new Array(inputs.length);
    const preprocess = async ({ role, uri }: (typeof inputs)[number]) => {
      request.assertCurrent();
      // The callback overload is supported by both native and React Native Web.
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
      });
      request.assertCurrent();
      const image = await manipulateAsync(uri, [mealImageResizeAction(dimensions.width, dimensions.height)], {
        compress: MEAL_ANALYSIS_IMAGE_COMPRESSION, format: SaveFormat.JPEG, base64: true,
      });
      if (!inputs.some((source) => source.uri === image.uri)) temporaryUris.push(image.uri);
      request.assertCurrent();
      if (!image.base64 || image.base64.length > 4 * 1024 * 1024) throw new Error('照片过大，请重新选择。');
      return { role, photo: `data:image/jpeg;base64,${image.base64}`, uri: image.uri, width: image.width, height: image.height };
    };
    let nextIndex = 0;
    let preprocessingFailed = false;
    let preprocessingFailure: unknown;
    const worker = async () => {
      while (nextIndex < inputs.length && !preprocessingFailed) {
        try {
          request.assertCurrent();
          const index = nextIndex++;
          processed[index] = await preprocess(inputs[index]);
        } catch (error) {
          if (!preprocessingFailed) preprocessingFailure = error;
          preprocessingFailed = true;
        }
      }
    };
    // Keep at most two native decode/resize operations active. Results are
    // indexed back into source order for the single whole-meal request.
    await Promise.all(Array.from({ length: Math.min(inputs.length, MEAL_ANALYSIS_IMAGE_CONCURRENCY) }, worker));
    request.assertCurrent();
    if (preprocessingFailed) throw preprocessingFailure;
    if (processed.some((image) => image === undefined)) throw new Error('照片处理未完成，请重试。');
    const orderedImages = processed as Array<Awaited<ReturnType<typeof preprocess>>>;
    const photos = orderedImages.map((image) => image.photo);
    const photoRoles = orderedImages.map((image) => image.role);
    sourcePhotos.push(...orderedImages.map(({ role, uri, width, height }) => ({ role, uri, width, height })));
    request.assertCurrent();
    const latest = meal.analyses?.filter((version) => version.sourceVersion === (meal.revision ?? 1)).at(-1);
    const dishCorrections = (latest?.analysis.components ?? [])
      .filter((component) => component.nutritionReferenceStale)
      .map((component) => ({
        label: component.label,
        ...(component.cookingMethod ? { cookingMethod: component.cookingMethod } : {}),
      }));
    const result = responseSchema.parse(await requestProvider(request.settings, 'meal', { foodName: meal.foodName, note: meal.note, mealType: meal.mealType, photos, photoRoles, dishCorrections }, request.signal, {
      promptProfile: 'frontend',
      timeoutMs: MEAL_ANALYSIS_STAGE_TIMEOUT_MS,
      createCrops: async ({ componentIndices, regions, signal: cropSignal }) => {
        request.assertCurrent();
        if (cropSignal.aborted || !regions.length || !sourcePhotos.length || !canCropMealPhotoRegions(sourcePhotos.length, photoRoles)) return undefined;
        const source = sourcePhotos.find((photo) => photo.role === 'before') ?? sourcePhotos[0];
        if (!source.width || !source.height) return undefined;
        const crops: string[] = [];
        const cropRoles: string[] = [];
        // A region has no image index. Multiple before views must be reviewed
        // together as originals; an unambiguous view may supply four crops.
        for (let index = 0; index < Math.min(regions.length, 4); index += 1) {
          request.assertCurrent();
          const region = regions[index];
          const marginX = Math.max(region.width * 0.18, 0.035);
          const marginY = Math.max(region.height * 0.18, 0.035);
          const x = Math.max(0, region.x - marginX), y = Math.max(0, region.y - marginY);
          const right = Math.min(1, region.x + region.width + marginX), bottom = Math.min(1, region.y + region.height + marginY);
          const originX = Math.floor(x * source.width), originY = Math.floor(y * source.height);
          const cropWidth = Math.max(1, Math.min(source.width - originX, Math.ceil((right - x) * source.width)));
          const cropHeight = Math.max(1, Math.min(source.height - originY, Math.ceil((bottom - y) * source.height)));
          try {
            const crop = await manipulateAsync(source.uri, [{ crop: { originX, originY, width: cropWidth, height: cropHeight } }, { resize: { width: 900 } }], { compress: 0.78, format: SaveFormat.JPEG, base64: true });
            if (crop.uri !== source.uri && !inputs.some((input) => input.uri === crop.uri)) temporaryUris.push(crop.uri);
            request.assertCurrent();
            if (crop.base64 && crop.base64.length <= 4 * 1024 * 1024) {
              crops.push(`data:image/jpeg;base64,${crop.base64}`);
              cropRoles.push(`${source.role}:crop:${componentIndices[index] + 1}`);
            }
          } catch (error) {
            request.assertCurrent();
            if (cropSignal.aborted) throw error;
            // The provider can still review the original image if local cropping is unavailable.
            return undefined;
          }
        }
        return crops.length ? { photos: crops, photoRoles: cropRoles } : undefined;
      },
    }));
    request.assertCurrent();
    const analysis = mealAnalysisSchema.parse(result.analysis);
    return { model: result.model, createdAt: result.createdAt, stageCount: result.stageCount, analysis };
  } finally {
    request.dispose();
    if (Platform.OS !== 'web' && FileSystem.cacheDirectory) {
      for (const uri of new Set(temporaryUris)) {
        if (uri.startsWith(FileSystem.cacheDirectory)) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
  }
}

export async function analyzeSummary(data: AppData, date: string, signal?: AbortSignal, _requestId?: string): Promise<{ markdown: string; model: string; createdAt: string; inputSnapshot: NonNullable<DailySummary['inputSnapshot']> }> {
  // A daily summary is a single end-to-end operation: bound both its request
  // stage and the enclosing lifecycle to 180 seconds total.
  const request = beginAiSettingsRequest(signal, DAILY_SUMMARY_TIMEOUT_MS);
  try {
    request.assertCurrent();
    const inputSnapshot = summaryInputSnapshot(data, date);
    let rawResult: Awaited<ReturnType<typeof requestProvider>>;
    try {
      rawResult = await requestProvider(request.settings, 'summary', { date, profile: inputSnapshot.profile, summary: inputSnapshot.summary }, request.signal, { timeoutMs: DAILY_SUMMARY_TIMEOUT_MS });
    } catch (error) {
      // Preserve the outer deadline's timeout/cancel/config-change reason when
      // it aborts the provider transport.
      request.assertCurrent();
      throw error;
    }
    const result = responseSchema.parse(rawResult);
    request.assertCurrent();
    return { markdown: z.object({ text: z.string().min(1) }).parse(result.analysis).text, model: result.model, createdAt: result.createdAt, inputSnapshot };
  } finally { request.dispose(); }
}
