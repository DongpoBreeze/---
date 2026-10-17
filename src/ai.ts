import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { z } from 'zod';
import { AppData, DailySummary, MealAnalysis, MealRecord, Profile } from './types';
import { summaryInputSnapshot } from './domain';
import { mealAnalysisSchema } from './nutrition-schema';
import { requestProvider } from './ai-provider';
import { getAiSettings, beginAiSettingsRequest } from './ai-settings';
export { loadAiSettings, saveAiSettings, clearAiSettings, getAiSettings, getAiSettingsVersion } from './ai-settings';
export { discoverModels, discoverModel, normalizeConnection, validateAiSettings } from './ai-provider';
export type { AiConnection, AiSettings, AiModel } from './ai-provider';

const responseSchema = z.object({ analysis: z.unknown(), model: z.string(), createdAt: z.string().datetime(), stageCount: z.number().int().min(1).max(3).optional() });

export const isAiConfigured = () => Boolean(getAiSettings());

export async function analyzeMeal(meal: MealRecord, profile: Profile, signal?: AbortSignal, _requestId?: string): Promise<{ analysis: MealAnalysis; model: string; createdAt: string; stageCount?: number }> {
  const request = beginAiSettingsRequest(signal);
  const sourcePhotos: { role: string; uri: string; width: number; height: number }[] = [];
  const temporaryUris: string[] = [];
  try {
    request.assertCurrent();
    const photos: string[] = [];
    const photoRoles: string[] = [];
    for (const [role, uri] of [['before', meal.imageUri], ['after', meal.afterImageUri]] as const) {
      if (!uri) continue;
      request.assertCurrent();
      const image = await manipulateAsync(uri, [{ resize: { width: 1200 } }], { compress: 0.75, format: SaveFormat.JPEG, base64: true });
      try {
        request.assertCurrent();
        if (!image.base64 || image.base64.length > 4 * 1024 * 1024) throw new Error('照片过大，请重新选择。');
        photos.push(`data:image/jpeg;base64,${image.base64}`);
        photoRoles.push(role);
        sourcePhotos.push({ role, uri: image.uri, width: image.width, height: image.height });
        if (image.uri !== uri) temporaryUris.push(image.uri);
      } catch (error) { throw error; }
    }
    request.assertCurrent();
    const result = responseSchema.parse(await requestProvider(request.settings, 'meal', { foodName: meal.foodName, mealType: meal.mealType, portion: meal.portion, remaining: meal.remaining ?? '未知', note: meal.note, profile, photos, photoRoles }, request.signal, {
      createCrops: async ({ componentIndices, regions, signal: cropSignal }) => {
        request.assertCurrent();
        if (cropSignal.aborted || !regions.length || !sourcePhotos.length) return undefined;
        const source = sourcePhotos.find((photo) => photo.role === 'before') ?? sourcePhotos[0];
        if (!source.width || !source.height) return undefined;
        const crops: string[] = [];
        const cropRoles: string[] = [];
        // The first request may contain the before/after pair (at most two
        // source photos), while a targeted review may inspect up to four
        // independent regions from the same meal. Keep this cap aligned with
        // the provider-side review payload limit so one low-confidence meal
        // can be reviewed in a single second request.
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
            request.assertCurrent();
            if (crop.base64 && crop.base64.length <= 4 * 1024 * 1024) {
              crops.push(`data:image/jpeg;base64,${crop.base64}`);
              cropRoles.push(`${source.role}:crop:${componentIndices[index] + 1}`);
              if (crop.uri !== source.uri) temporaryUris.push(crop.uri);
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
  const request = beginAiSettingsRequest(signal);
  try {
    request.assertCurrent();
    const inputSnapshot = summaryInputSnapshot(data, date);
    const result = responseSchema.parse(await requestProvider(request.settings, 'summary', { date, profile: inputSnapshot.profile, summary: inputSnapshot.summary }, request.signal));
    request.assertCurrent();
    return { markdown: z.object({ text: z.string().min(1) }).parse(result.analysis).text, model: result.model, createdAt: result.createdAt, inputSnapshot };
  } finally { request.dispose(); }
}

export async function getGatewayStatus(): Promise<boolean> {
  return isAiConfigured();
}
