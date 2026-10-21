import JSZip from 'jszip';
import { z } from 'zod';
import type { AppData, DailySummary } from './types';
import { mealAnalysisSchema } from './nutrition-schema';
import { MAX_MEAL_PHOTOS, mealAnalysisPhotoSources } from './meal-photos';
import { mealAnalysisDraftSchema } from './meal-analysis-draft';

/** The archive format is deliberately independent of any Expo or AI provider API. */
export const BACKUP_FORMAT = 'health-compass-backup';
export const BACKUP_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRY_COUNT = 10_000;

const MEDIA_DIR = 'media';
const DATA_FILE = 'data.json';
const MANIFEST_FILE = 'manifest.json';
const CSV_FILE = 'records.csv';
const README_FILE = 'README.md';

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

export type BackupMediaInput = {
  uri: string;
  kind: 'image' | 'video';
  bytes: Uint8Array;
  mimeType?: string;
  extension?: string;
};

export type BackupMediaEntry = {
  path: string;
  kind: 'image' | 'video';
  mimeType?: string;
  extension: string;
  byteLength: number;
  sha256: string;
  bytes: Uint8Array;
};

export type ParsedBackup = {
  data: AppData;
  media: BackupMediaEntry[];
  manifest: BackupManifest;
  drafts: Record<string, unknown>;
};

export type HashBytes = (bytes: Uint8Array) => Promise<string>;
export type BackupOptions = { hash?: HashBytes; drafts?: Record<string, unknown> };

type BackupManifestMedia = Omit<BackupMediaEntry, 'bytes'>;
export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_VERSION;
  exportedAt: string;
  files: Record<string, { byteLength: number; sha256: string }>;
  media: BackupManifestMedia[];
  fields: { data: string; records: string; summaries: string; media: string };
};

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const id = z.string().min(1).max(256);
const iso = z.string().max(128).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/).refine((v) => Number.isFinite(Date.parse(v)), 'invalid date');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }, 'invalid day');
const timezone = z.string().min(1).max(128).refine((value) => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'invalid timezone');
const uri = z.string().min(1).max(Math.ceil(MAX_ENTRY_BYTES * 1.4));
const beforePhotoUris = z.array(uri).max(MAX_MEAL_PHOTOS);
const analysisVersion = z.object({ id, model: z.string().min(1), createdAt: iso, sourceVersion: z.number().int().positive(), stageCount: z.number().int().min(1).max(3).optional(), analysis: mealAnalysisSchema }).strict();
const exerciseSet = z.object({ reps: nonnegative.int(), weight: nonnegative, unit: z.enum(['kg', 'lb']), isWarmup: z.boolean().optional() }).strict();
const mealBase = z.object({
  id,
  type: z.literal('meal'),
  createdAt: iso,
  occurredAt: iso,
  mealType: z.enum(['早餐', '午餐', '晚餐', '加餐']),
  foodName: z.string(),
  foodNameSource: z.enum(['analysis', 'user']).optional(),
  portion: z.string(),
  note: z.string(),
  imageUri: uri.optional(),
  beforeImageUris: beforePhotoUris.optional(),
  imageBase64: z.string().optional(),
  afterImageUri: uri.optional(),
  remaining: z.string().optional(),
  revision: z.number().int().positive().optional(),
  updatedAt: iso.optional(),
  timezone: timezone.optional(),
  analyses: z.array(analysisVersion).optional(),
  source: z.enum(['manual', 'photo', 'ai']),
  estimate: z.object({ calories: nonnegative, protein: nonnegative, carbs: nonnegative, fat: nonnegative }).strict().optional(),
  estimateStatus: z.enum(['estimated', 'unknown']),
}).strict();
const mealRecord = mealBase.extend({ revisions: z.array(mealBase).optional() });
const trainingRecord = z.object({
  id,
  type: z.literal('training'),
  createdAt: iso,
  occurredAt: iso,
  exercise: z.string(),
  sets: z.array(exerciseSet),
  note: z.string(),
  pain: z.enum(['yes', 'no', 'unknown']),
  controlled: z.enum(['yes', 'no', 'unknown']),
  rir: z.enum(['0', '1', '2', '3', '4+', 'unknown']),
  videoUri: uri.optional(),
  mode: z.enum(['strength', 'cardio']).optional(),
  durationMinutes: nonnegative.optional(),
  targetSets: nonnegative.int().optional(),
  targetMin: nonnegative.int().optional(),
  targetMax: nonnegative.int().optional(),
  increment: nonnegative.optional(),
  weightBasis: z.enum(['total', 'per-hand', 'bodyweight']).optional(),
  updatedAt: iso.optional(),
  timezone: timezone.optional(),
}).strict();
const exerciseTemplate = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  setCount: z.number().int().min(1).max(60),
  weightUnit: z.enum(['kg', 'lb']),
  weightBasis: z.enum(['total', 'per-hand', 'bodyweight']),
  targetSets: nonnegative.int().optional(),
  targetMin: nonnegative.int().optional(),
  targetMax: nonnegative.int().optional(),
  increment: nonnegative.optional(),
}).strict();
const sleepRecord = z.object({
  id,
  type: z.literal('sleep'),
  createdAt: iso,
  occurredAt: iso,
  fellAsleepAt: iso,
  wokeAt: iso,
  awakeMinutes: nonnegative.nullable(),
  quality: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  note: z.string(),
  updatedAt: iso.optional(),
  timezone: timezone.optional(),
}).strict();
const summaryRecord = z.object({
  id,
  date: day,
  markdown: z.string(),
  sourceVersion: z.number().int().nonnegative(),
  status: z.enum(['current', 'stale']),
  createdAt: iso,
  source: z.enum(['local', 'ai']).optional(),
  model: z.string().optional(),
  sourceRecordIds: z.array(id).optional(),
  inputSnapshot: z.object({
    date: day,
    profile: z.object({ goal: z.enum(['health', 'fat-loss', 'muscle-gain']).optional(), heightCm: nonnegative.optional(), weightKg: nonnegative.optional(), calorieTarget: nonnegative.optional() }).strict(),
    summary: z.string(),
    recordVersions: z.array(z.object({ id, version: z.string() }).strict()),
  }).strict().optional(),
}).strict();
const profile = z.object({
  goal: z.enum(['health', 'fat-loss', 'muscle-gain']).optional(),
  heightCm: nonnegative.optional(),
  weightKg: nonnegative.optional(),
  calorieTarget: nonnegative.optional(),
}).strict();
const appDataSchema = z.object({
  version: z.literal(1),
  profile,
  meals: z.array(mealRecord),
  trainings: z.array(trainingRecord),
  sleeps: z.array(sleepRecord),
  exerciseTemplates: z.array(exerciseTemplate).optional(),
  summaries: z.array(summaryRecord),
  sourceVersion: z.number().int().nonnegative(),
  drafts: z.object({ meal: mealRecord.partial().optional(), training: trainingRecord.partial().optional(), sleep: sleepRecord.partial().optional() }).strict().optional(),
}).strict();

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_VERSION),
  exportedAt: iso,
  files: z.record(z.string(), z.object({ byteLength: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  media: z.array(z.object({ path: z.string(), kind: z.enum(['image', 'video']), mimeType: z.string().regex(/^(image|video)\/[a-zA-Z0-9.+-]+$/).optional(), extension: z.string().regex(/^[a-z0-9]{1,12}$/), byteLength: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  fields: z.object({ data: z.string(), records: z.string(), summaries: z.string(), media: z.string() }),
}).passthrough();

type ZipMetadata = { name: string; compressedSize: number; byteLength: number };

// Reject unsafe paths, duplicate entries, and oversized expansion before loading any archive contents.
export function inspectArchive(input: Uint8Array): ZipMetadata[] {
  if (input.byteLength > MAX_ARCHIVE_BYTES) fail('archive-too-large', '备份文件超过 256 MB 限制');
  if (input.byteLength < 22) fail('invalid-archive', '备份文件不是 ZIP');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let end = -1;
  for (let position = input.length - 22; position >= Math.max(0, input.length - 65557); position--) {
    if (view.getUint32(position, true) === 0x06054b50 && position + 22 + view.getUint16(position + 20, true) === input.length) { end = position; break; }
  }
  if (end < 0) fail('invalid-archive', 'ZIP 目录损坏');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) fail('unsupported-archive', '不支持分卷 ZIP');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('unsupported-archive', '不支持 ZIP64');
  if (count > MAX_ENTRY_COUNT) fail('archive-too-large', '备份文件包含过多条目');
  if (centralOffset + centralSize !== end) fail('invalid-archive', 'ZIP 目录边界不合法');
  const result: ZipMetadata[] = [];
  const seen = new Set<string>();
  let cursor = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('invalid-archive', 'ZIP 条目目录损坏');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const byteLength = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 1 || ![0, 8].includes(method)) fail('unsupported-archive', '不支持加密 ZIP 或此压缩算法');
    if (byteLength > MAX_ENTRY_BYTES || compressedSize > MAX_ARCHIVE_BYTES) fail('entry-too-large', '备份条目超过 128 MB 限制');
    expandedTotal += byteLength;
    if (expandedTotal > MAX_TOTAL_BYTES) fail('archive-too-large', '备份展开后超过 512 MB 限制');
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) fail('invalid-archive', 'ZIP 条目超出目录边界');
    const name = String.fromCharCode(...input.subarray(cursor + 46, cursor + 46 + nameLength));
    const fileName = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!safePath(fileName)) fail('path-traversal', '备份中含有不安全路径');
    if (seen.has(name)) fail('duplicate-path', 'ZIP 路径重复');
    seen.add(name);
    if ((name === MANIFEST_FILE && byteLength > 1024 * 1024) || (name.endsWith('.json') && byteLength > MAX_JSON_BYTES)) fail('entry-too-large', '备份 JSON 条目过大');
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) fail('invalid-archive', 'ZIP 本地文件头损坏');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30;
    if (start + localNameLength + localExtraLength + compressedSize > centralOffset) fail('invalid-archive', 'ZIP 压缩内容超出边界');
    if (String.fromCharCode(...input.subarray(start, start + localNameLength)) !== name || view.getUint16(localOffset + 8, true) !== method) fail('invalid-archive', 'ZIP 本地文件头与目录不一致');
    result.push({ name, compressedSize, byteLength });
    cursor = next;
  }
  if (cursor !== end) fail('invalid-archive', 'ZIP 条目数量与目录不一致');
  return result;
}

function fail(code: string, message: string): never {
  throw new BackupError(code, message);
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Node and browser default; the native adapter supplies Expo Crypto's SHA-256. */
export const sha256Hex: HashBytes = async (input) => {
  if (!globalThis.crypto?.subtle) fail('crypto-unavailable', 'SHA-256 不可用，请在安全环境中运行');
  const bytes = Uint8Array.from(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
};

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function json(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

function escapeCsv(value: unknown): string {
  const textValue = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

function recordsCsv(data: AppData): string {
  const rows = [['type', 'id', 'occurredAt', 'summary', 'json']];
  for (const item of [...data.meals, ...data.trainings, ...data.sleeps]) {
    rows.push([item.type, item.id, item.occurredAt, item.type === 'meal' ? item.foodName : item.type === 'training' ? item.exercise : item.note, JSON.stringify(item)]);
  }
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n';
}

function moduleCsv(records: unknown[], columns: string[]): Uint8Array {
  const rows = [columns, ...records.map((entry) => columns.map((key) => (entry as Record<string, unknown>)[key]))];
  return utf8(rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n');
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !path.startsWith('/') && !path.includes('\\') && path.split('/').every((part) => part && part !== '.' && part !== '..' && !['__proto__', 'constructor', 'prototype'].includes(part)) && /^[A-Za-z0-9._/-]+$/.test(path);
}

function extFor(input: BackupMediaInput): string {
  const explicit = input.extension?.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (explicit) return explicit.slice(0, 12);
  const fromUri = input.uri.match(/\.([A-Za-z0-9]{1,12})(?:[?#].*)?$/)?.[1]?.toLowerCase();
  if (fromUri) return fromUri;
  return input.kind === 'video' ? 'mp4' : 'jpg';
}

function allMediaPaths(data: unknown): Array<{ value: string; kind: 'image' | 'video' }> {
  const result: Array<{ value: string; kind: 'image' | 'video' }> = [];
  visitFormMedia(data, (value, kind) => result.push({ value, kind }));
  return result;
}

function visitFormMedia(value: unknown, visit: (uri: string, kind: 'image' | 'video', set: (replacement: string) => void) => void): void {
  if (Array.isArray(value)) { for (const child of value) visitFormMedia(child, visit); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['imageUri', 'afterImageUri', 'videoUri'].includes(key) && typeof child === 'string' && child) {
      visit(child, key === 'videoUri' ? 'video' : 'image', (replacement) => { (value as Record<string, unknown>)[key] = replacement; });
    } else if (key === 'beforeImageUris' && Array.isArray(child)) {
      child.forEach((uri, index) => {
        if (typeof uri === 'string' && uri) visit(uri, 'image', (replacement) => { child[index] = replacement; });
      });
    } else visitFormMedia(child, visit);
  }
}

function validatePhotoCollections(value: unknown, code: 'invalid-data' | 'invalid-draft'): void {
  if (Array.isArray(value)) { for (const child of value) validatePhotoCollections(child, code); return; }
  if (!value || typeof value !== 'object') return;
  if ('beforeImageUris' in value && value.beforeImageUris !== undefined) {
    const photos = value as { imageUri?: string; beforeImageUris?: string[]; afterImageUri?: string };
    if (!beforePhotoUris.safeParse(photos.beforeImageUris).success) fail(code, '餐前照片列表不合法');
    try { mealAnalysisPhotoSources(photos); }
    catch (error) { fail(code, error instanceof Error ? error.message : '餐前照片列表不合法'); }
  }
  for (const child of Object.values(value)) validatePhotoCollections(child, code);
}

export function validateFormDrafts(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-draft', '草稿数据不合法');
  const keys = Object.keys(value);
  if (keys.length > 100 || keys.some((key) => !/^[a-zA-Z0-9_-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) fail('invalid-draft', '草稿名称不合法');
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail('invalid-draft', '草稿不是可序列化数据'); }
  if (utf8(encoded!).byteLength > MAX_TOTAL_BYTES) fail('entry-too-large', '草稿数据超过大小限制');
  validatePhotoCollections(value, 'invalid-draft');
  for (const [key, draft] of Object.entries(value)) {
    if ((key === 'meal' || key.startsWith('meal-')) && draft && typeof draft === 'object' && 'analysisDraft' in draft) {
      const parsed = mealAnalysisDraftSchema.safeParse(draft.analysisDraft);
      if (!parsed.success) fail('invalid-draft', `餐食分析草稿校验失败：${parsed.error.issues[0]?.message ?? '字段不兼容'}`);
    }
  }
  return JSON.parse(encoded!) as Record<string, unknown>;
}

export function collectDraftMediaReferences(drafts: Record<string, unknown>): Array<{ uri: string; kind: 'image' | 'video' }> {
  const references = new Map<string, { uri: string; kind: 'image' | 'video' }>();
  visitFormMedia(drafts, (uri, kind) => { references.set(uri, { uri, kind }); });
  return [...references.values()];
}

export function remapDraftMedia(drafts: Record<string, unknown>, replacements: Map<string, string>): Record<string, unknown> {
  const result = validateFormDrafts(drafts);
  visitFormMedia(result, (uri, _kind, set) => { const replacement = replacements.get(uri); if (replacement) set(replacement); });
  return result;
}

/** Validate source data without converting unknown or corrupt records into empty data. */
export function validateAppData(value: unknown): AppData {
  if (typeof value === 'object' && value !== null && 'version' in value && (value as { version: unknown }).version !== 1) fail('unsupported-version', '数据版本不受支持');
  const result = appDataSchema.safeParse(value);
  if (!result.success) fail('invalid-data', `数据校验失败：${result.error.issues[0]?.message ?? '字段不完整'}`);
  const data = result.data as AppData;
  validatePhotoCollections(data, 'invalid-data');
  const ids = new Set<string>();
  for (const record of [...data.meals, ...data.trainings, ...data.sleeps]) {
    if (ids.has(record.id)) fail('duplicate-id', `记录 ID 重复：${record.id}`);
    ids.add(record.id);
  }
  const summaryIds = new Set<string>();
  for (const summary of data.summaries) {
    if (summaryIds.has(summary.id)) fail('duplicate-id', `摘要 ID 重复：${summary.id}`);
    summaryIds.add(summary.id);
  }
  const templateIds = new Set<string>();
  const templateNames = new Set<string>();
  for (const template of data.exerciseTemplates ?? []) {
    const name = template.name.trim().toLocaleLowerCase();
    if (templateIds.has(template.id) || templateNames.has(name)) fail('duplicate-id', `动作模板重复：${template.name}`);
    templateIds.add(template.id);
    templateNames.add(name);
  }
  for (const meal of data.meals) {
    const analysisIds = new Set<string>();
    for (const analysis of meal.analyses ?? []) {
      if (analysisIds.has(analysis.id)) fail('duplicate-id', `分析 ID 重复：${analysis.id}`);
      analysisIds.add(analysis.id);
    }
    const versions = new Set<number>();
    for (const revision of meal.revisions ?? []) {
      if (revision.id !== meal.id) fail('invalid-data', '餐食修订与原始记录 ID 不一致');
      const version = revision.revision ?? 1;
      if (versions.has(version)) fail('duplicate-revision', `餐食修订版本重复：${meal.id}`);
      versions.add(version);
    }
  }
  for (const sleep of data.sleeps) {
    const minutes = (Date.parse(sleep.wokeAt) - Date.parse(sleep.fellAsleepAt)) / 60_000;
    if (minutes <= 0 || minutes > 1440 || sleep.awakeMinutes !== null && sleep.awakeMinutes > minutes) fail('invalid-data', `睡眠时间或清醒时长不合法：${sleep.id}`);
  }
  for (const summary of data.summaries) {
    if (summary.sourceRecordIds?.some((recordId) => !ids.has(recordId))) fail('invalid-data', `摘要引用了不存在的记录：${summary.id}`);
    if (summary.inputSnapshot?.recordVersions.some((record) => !ids.has(record.id))) fail('invalid-data', `摘要输入快照引用了不存在的记录：${summary.id}`);
  }
  return data;
}

export function collectMediaReferences(data: AppData): Array<{ uri: string; kind: 'image' | 'video' }> {
  const seen = new Set<string>();
  return allMediaPaths(data).filter((entry) => { const key = `${entry.kind}\0${entry.value}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((entry) => ({ uri: entry.value, kind: entry.kind }));
}

function replaceMediaPaths(data: AppData, replacements: Map<string, string>): AppData {
  const clone = JSON.parse(JSON.stringify(data)) as AppData;
  visitFormMedia(clone, (uri, _kind, set) => { const replacement = replacements.get(uri); if (replacement) set(replacement); });
  return clone as AppData;
}

export async function createBackupArchive(dataInput: AppData, mediaInputs: BackupMediaInput[], exportedAt = new Date().toISOString(), options: BackupOptions = {}): Promise<Uint8Array> {
  const hashBytes = options.hash ?? sha256Hex;
  const drafts = validateFormDrafts(options.drafts ?? {});
  const data = validateAppData(dataInput);
  const byUri = new Map<string, BackupMediaInput>();
  for (const item of mediaInputs) {
    if (!item.uri || !item.bytes?.byteLength) fail('missing-media', '备份媒体缺少原始字节');
    if (item.bytes.byteLength > MAX_ENTRY_BYTES) fail('entry-too-large', '单个媒体文件超过 128 MB 限制');
    const existing = byUri.get(`${item.kind}\0${item.uri}`);
    if (existing && await hashBytes(existing.bytes) !== await hashBytes(item.bytes)) fail('media-conflict', `同一媒体 URI 的内容不一致：${item.uri}`);
    byUri.set(`${item.kind}\0${item.uri}`, item);
  }
  const refs = [...collectMediaReferences(data), ...collectDraftMediaReferences(drafts)];
  const referenceKinds = new Map<string, 'image' | 'video'>();
  for (const ref of refs) {
    const kind = referenceKinds.get(ref.uri);
    if (kind && kind !== ref.kind) fail('invalid-media', '同一个媒体被引用为照片和视频两种类型');
    referenceKinds.set(ref.uri, ref.kind);
  }
  const refKeys = new Set(refs.map((r) => `${r.kind}\0${r.uri}`));
  for (const ref of refs) if (!byUri.has(`${ref.kind}\0${ref.uri}`)) fail('missing-media', '关联媒体无法读取，备份未生成');
  const pathByKey = new Map<string, string>();
  const entriesByPath = new Map<string, BackupMediaEntry>();
  for (const input of byUri.values()) {
    const key = `${input.kind}\0${input.uri}`;
    if (!refKeys.has(key)) continue;
    const hash = await hashBytes(input.bytes);
    const extension = extFor(input);
    const path = `${MEDIA_DIR}/${input.kind}-${hash}.${extension}`;
    pathByKey.set(key, path);
    entriesByPath.set(path, { path, kind: input.kind, mimeType: input.mimeType, extension, byteLength: input.bytes.byteLength, sha256: hash, bytes: input.bytes });
  }
  const replacements = new Map<string, string>();
  for (const ref of refs) replacements.set(ref.uri, pathByKey.get(`${ref.kind}\0${ref.uri}`)!);
  const portableData = replaceMediaPaths(data, replacements);
  const mediaEntries = [...entriesByPath.values()];
  const portableDrafts = remapDraftMedia(drafts, replacements);
  const summaryFiles = data.summaries.map((summary, index) => ({ path: `summaries/${summary.date}-${index + 1}.md`, bytes: utf8(summary.markdown) }));
  const dataBytes = json(portableData);
  const csvBytes = utf8(recordsCsv(portableData));
  const readmeBytes = utf8([
    '# Health Compass Backup v1', '',
    'manifest.json describes every payload with its byte length and SHA-256 of the original bytes. Checksums detect corruption; this backup is not encrypted or digitally signed.', '',
    'data.json is the canonical UTF-8 data model. version=1; profile contains optional goal, heightCm, weightKg and calorieTarget. meals, trainings and sleeps have stable id/type/createdAt/occurredAt fields. Unknown fields and unsupported versions are rejected during restoration.', '',
    'Meal corrections are in revisions; analyses preserve id, model, createdAt, sourceVersion and analysis. Model estimates keep nutrient min/max ranges, assumptions and an explicit estimated/unknown status. Null and unknown are not zero.', '',
    'Training weights retain kg/lb and total/per-hand/bodyweight basis. Exercise sets retain repetitions and warmup flags. Sleep timestamps include an offset; awakeMinutes=null means unknown. Timestamps retain their source text and recorded timezone.', '',
    'records.csv contains a machine-readable JSON column and readable labels. meals.csv, trainings.csv and sleeps.csv expose module fields; arrays and estimates use JSON within valid quoted CSV cells.', '',
    'drafts.json preserves unfinished form values. AppData.drafts remains in data.json. All imageUri/beforeImageUris/afterImageUri/videoUri values point to media/ entries, including corrections and drafts. beforeImageUris contains ordered original before-meal photos; imageUri mirrors the first and legacy imageUri-only meals remain readable. Each media entry contains original bytes; imageBase64, when present, is an analysis copy and never replaces the original file.', '',
    'summaries/ contains every saved daily Markdown version, in the same order as data.json summaries. AI summaries preserve model/sourceRecordIds/inputSnapshot where present. Local summaries are derived from local rules.', '',
    'Import is a non-destructive union: identical record IDs and facts are deduplicated, differing facts/profile/drafts cause a visible conflict. Existing local summary revisions may be regenerated. Media is staged before the app commits data. Exported copies outside the app cannot be revoked by deleting local data.', '',
    'Limits: 256 MiB ZIP, 128 MiB per payload, 512 MiB expanded, 16 MiB per archive JSON, 10,000 entries. ZIP64, encrypted and multi-volume archives are unsupported.', '',
  ].join('\n'));
  const payloads: Array<{ path: string; bytes: Uint8Array }> = [
    { path: DATA_FILE, bytes: dataBytes }, { path: 'drafts.json', bytes: json(portableDrafts) }, { path: CSV_FILE, bytes: csvBytes },
    { path: 'meals.csv', bytes: moduleCsv(portableData.meals, ['id', 'createdAt', 'updatedAt', 'occurredAt', 'timezone', 'mealType', 'foodName', 'foodNameSource', 'portion', 'remaining', 'note', 'source', 'revision', 'estimateStatus', 'estimate', 'imageUri', 'beforeImageUris', 'afterImageUri', 'analyses', 'revisions']) },
    { path: 'trainings.csv', bytes: moduleCsv(portableData.trainings, ['id', 'createdAt', 'updatedAt', 'occurredAt', 'timezone', 'exercise', 'mode', 'durationMinutes', 'sets', 'weightBasis', 'targetSets', 'targetMin', 'targetMax', 'increment', 'pain', 'controlled', 'rir', 'note', 'videoUri']) },
    { path: 'sleeps.csv', bytes: moduleCsv(portableData.sleeps, ['id', 'createdAt', 'updatedAt', 'occurredAt', 'timezone', 'fellAsleepAt', 'wokeAt', 'awakeMinutes', 'quality', 'note']) },
    { path: README_FILE, bytes: readmeBytes }, ...summaryFiles, ...mediaEntries.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
  ];
  const files: Record<string, { byteLength: number; sha256: string }> = {};
  if (payloads.length + 1 > MAX_ENTRY_COUNT) fail('archive-too-large', '备份条目过多');
  let total = 0;
  for (const payload of payloads) {
    total += payload.bytes.byteLength;
    if (payload.bytes.byteLength > MAX_ENTRY_BYTES || payload.path.endsWith('.json') && payload.bytes.byteLength > MAX_JSON_BYTES) fail('entry-too-large', `备份条目过大：${payload.path}`);
    if (total > MAX_TOTAL_BYTES) fail('archive-too-large', '备份展开后超过 512 MB 限制');
    files[payload.path] = { byteLength: payload.bytes.byteLength, sha256: await hashBytes(payload.bytes) };
  }
  const manifest: BackupManifest = { format: BACKUP_FORMAT, formatVersion: BACKUP_VERSION, exportedAt, files, media: mediaEntries.map(({ bytes: _bytes, ...entry }) => entry), fields: { data: DATA_FILE, records: CSV_FILE, summaries: 'summaries/*.md', media: `${MEDIA_DIR}/*` } };
  const manifestBytes = json(manifest);
  if (manifestBytes.byteLength > 1024 * 1024) fail('entry-too-large', '备份清单超过 1 MB 限制');
  const zip = new JSZip();
  zip.file(MANIFEST_FILE, manifestBytes, { binary: true, createFolders: false });
  for (const payload of payloads) zip.file(payload.path, payload.bytes, { binary: true, createFolders: false });
  const result = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (result.byteLength > MAX_ARCHIVE_BYTES) fail('archive-too-large', '备份文件超过大小限制');
  return result;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try { return JSON.parse(text(bytes)) as T; } catch { fail('invalid-archive', `${label} 不是有效 JSON`); }
}

async function inflateLimited(file: JSZip.JSZipObject, expected: number): Promise<Uint8Array> {
  type Stream = { on(event: string, callback: (...args: any[]) => void): Stream; resume(): Stream; pause(): Stream };
  const stream = (file as JSZip.JSZipObject & { internalStream(type: string): Stream }).internalStream('uint8array');
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let stopped = false;
    stream.on('data', (chunk: Uint8Array) => {
      length += chunk.byteLength;
      if (length > expected || length > MAX_ENTRY_BYTES) {
        stopped = true;
        stream.pause();
        reject(new BackupError('entry-too-large', 'ZIP 实际展开大小超过声明或限制'));
      } else chunks.push(chunk);
    });
    stream.on('error', () => { if (!stopped) reject(new BackupError('invalid-archive', 'ZIP 压缩内容损坏')); });
    stream.on('end', () => {
      if (stopped) return;
      if (length !== expected) { reject(new BackupError('integrity', 'ZIP 实际内容大小与目录不一致')); return; }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      resolve(bytes);
    });
    stream.resume();
  });
}

function validateManifest(value: unknown): BackupManifest {
  if (typeof value === 'object' && value !== null && 'formatVersion' in value && (value as { formatVersion: unknown }).formatVersion !== BACKUP_VERSION) fail('unsupported-version', '备份格式版本不受支持');
  const result = manifestSchema.safeParse(value);
  if (!result.success) fail('invalid-manifest', `备份清单校验失败：${result.error.issues[0]?.message ?? '格式错误'}`);
  return result.data as BackupManifest;
}

export async function parseBackupArchive(input: Uint8Array | ArrayBuffer, options: Pick<BackupOptions, 'hash'> = {}): Promise<ParsedBackup> {
  const hashBytes = options.hash ?? sha256Hex;
  const bytes = asBytes(input);
  const metadata = inspectArchive(bytes);
  const metadataByPath = new Map(metadata.map((entry) => [entry.name, entry]));
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false }); } catch { fail('invalid-archive', '备份文件损坏或不是 ZIP'); }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRY_COUNT) fail('archive-too-large', '备份文件包含过多条目');
  for (const name of names) {
    const item = zip.files[name];
    if (!item.dir && (!safePath(name) || item.unsafeOriginalName && !safePath(item.unsafeOriginalName))) fail('path-traversal', '备份中含有不安全路径');
    if (item.dir) continue;
  }
  const manifestFile = zip.file(MANIFEST_FILE);
  if (!manifestFile) fail('invalid-manifest', '备份缺少 manifest.json');
  const manifest = validateManifest(parseJson(await inflateLimited(manifestFile, metadataByPath.get(MANIFEST_FILE)!.byteLength), MANIFEST_FILE));
  if (manifest.fields.data !== DATA_FILE || manifest.fields.records !== CSV_FILE || manifest.fields.summaries !== 'summaries/*.md' || manifest.fields.media !== `${MEDIA_DIR}/*`) fail('invalid-manifest', '备份字段映射不受支持');
  const manifestPaths = new Set(Object.keys(manifest.files));
  for (const required of [DATA_FILE, 'drafts.json', CSV_FILE, 'meals.csv', 'trainings.csv', 'sleeps.csv', README_FILE]) if (!manifestPaths.has(required)) fail('invalid-manifest', `备份缺少必要文件：${required}`);
  for (const path of manifestPaths) if (!safePath(path) || !zip.file(path)) fail('invalid-manifest', `清单中的文件缺失：${path}`);
  for (const name of names) if (name !== MANIFEST_FILE && !zip.files[name].dir && !manifestPaths.has(name)) fail('invalid-manifest', `清单未声明文件：${name}`);
  const fileBytes = new Map<string, Uint8Array>();
  for (const path of manifestPaths) {
    const file = zip.file(path)!;
    if (metadataByPath.get(path)?.byteLength !== manifest.files[path].byteLength) fail('integrity', `清单声明大小与 ZIP 不一致：${path}`);
    const content = await inflateLimited(file, manifest.files[path].byteLength);
    if (content.byteLength > MAX_ENTRY_BYTES) fail('entry-too-large', `备份条目过大：${path}`);
    const expected = manifest.files[path];
    if (content.byteLength !== expected.byteLength || await hashBytes(content) !== expected.sha256) fail('integrity', `备份条目完整性校验失败：${path}`);
    fileBytes.set(path, content);
  }
  const data = validateAppData(parseJson(fileBytes.get(DATA_FILE) ?? fail('invalid-archive', '备份缺少 data.json'), DATA_FILE));
  const mediaByPath = new Map<string, BackupManifestMedia>();
  for (const item of manifest.media) {
    if (!safePath(item.path) || !item.path.startsWith(`${MEDIA_DIR}/`)) fail('path-traversal', `媒体路径不安全：${item.path}`);
    if (mediaByPath.has(item.path)) fail('invalid-manifest', `媒体路径重复：${item.path}`);
    mediaByPath.set(item.path, item);
    const declared = manifest.files[item.path];
    if (!declared || declared.sha256 !== item.sha256 || declared.byteLength !== item.byteLength) fail('integrity', `媒体校验字段不一致：${item.path}`);
    if (item.mimeType && !item.mimeType.startsWith(`${item.kind}/`)) fail('invalid-media', '媒体 MIME 类型与种类不一致');
  }
  for (const item of manifest.media) if (!fileBytes.has(item.path)) fail('missing-media', `备份缺少媒体：${item.path}`);
  for (const ref of allMediaPaths(data)) {
    const item = mediaByPath.get(ref.value);
    if (!item) fail('missing-media', `记录引用的媒体不存在：${ref.value}`);
    if (item.kind !== ref.kind) fail('invalid-media', `媒体类型与记录不匹配：${ref.value}`);
  }
  const media = manifest.media.map((item) => ({ ...item, bytes: fileBytes.get(item.path)! }));
  const drafts = validateFormDrafts(parseJson(fileBytes.get('drafts.json') ?? fail('invalid-archive', '备份缺少草稿文件'), 'drafts.json'));
  for (const ref of collectDraftMediaReferences(drafts)) {
    const item = mediaByPath.get(ref.uri);
    if (!item || item.kind !== ref.kind) fail('missing-media', `草稿媒体不存在或类型错误：${ref.uri}`);
  }
  const referenced = new Set([...collectMediaReferences(data), ...collectDraftMediaReferences(drafts)].map((ref) => ref.uri));
  for (const item of media) if (!referenced.has(item.path)) fail('invalid-media', '备份包含无记录关联的媒体');
  for (let index = 0; index < data.summaries.length; index++) {
    const summary = data.summaries[index];
    const path = `summaries/${summary.date}-${index + 1}.md`;
    const content = fileBytes.get(path);
    if (!content || text(content) !== summary.markdown) fail('integrity', `每日 Markdown 与数据不一致：${path}`);
  }
  return { data, media, manifest, drafts };
}

export function remapBackupMedia(data: AppData, replacements: Map<string, string>): AppData {
  return replaceMediaPaths(validateAppData(data), replacements);
}

export function canonicalJson(value: unknown, mediaAliases?: ReadonlyMap<string, string>): string {
  const normalize = (entry: unknown, field?: string): unknown => {
    if (Array.isArray(entry)) return entry.map((child) => normalize(child, field === 'beforeImageUris' ? 'imageUri' : undefined));
    if (typeof entry === 'string' && mediaAliases && ['imageUri', 'afterImageUri', 'videoUri'].includes(field ?? '')) return mediaAliases.get(entry) ?? entry;
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child, key)]));
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function mergeFormDrafts(current: Record<string, unknown>, incoming: Record<string, unknown>, equivalent = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)): Record<string, unknown> {
  const result = validateFormDrafts(current);
  for (const [kind, value] of Object.entries(validateFormDrafts(incoming))) {
    if (kind in result && !equivalent(result[kind], value)) fail('import-conflict', `本机与备份中的 ${kind} 草稿不一致`);
    if (!(kind in result)) result[kind] = value;
  }
  return result;
}

/** Non-destructive union. Conflicting facts require an explicit user resolution outside this codec. */
export function mergeBackupData(currentInput: AppData, incomingInput: AppData, equivalent?: (current: unknown, incoming: unknown) => boolean): AppData {
  const current = validateAppData(currentInput);
  const incoming = validateAppData(incomingInput);
  const equals = equivalent ?? ((a, b) => canonicalJson(a) === canonicalJson(b));
  const profileResult = { ...current.profile };
  for (const [key, value] of Object.entries(incoming.profile)) {
    const existing = (profileResult as Record<string, unknown>)[key];
    if (existing !== undefined && !equals(existing, value)) fail('import-conflict', `本机与备份中的资料 ${key} 不一致`);
    (profileResult as Record<string, unknown>)[key] = value;
  }
  const mergeRecords = <T extends { id: string }>(left: T[], right: T[]): T[] => {
    const result = [...left];
    const byId = new Map(left.map((record) => [record.id, record]));
    for (const record of right) {
      const existing = byId.get(record.id);
      if (existing && !equals(existing, record)) fail('import-conflict', `记录内容冲突：${record.id}`);
      if (!existing) { byId.set(record.id, record); result.push(record); }
    }
    return result;
  };
  const summaries: DailySummary[] = [...current.summaries];
  for (const summary of incoming.summaries) {
    const existing = summaries.find((item) => item.id === summary.id);
    if (!existing) { summaries.push(summary); continue; }
    if (existing.source === 'local' && summary.source === 'local') continue;
    const original = { ...existing, status: undefined };
    const restored = { ...summary, status: undefined };
    if (!equals(original, restored)) fail('import-conflict', `分析总结内容冲突：${summary.id}`);
  }
  const drafts = mergeFormDrafts(current.drafts ?? {}, incoming.drafts ?? {}, equals);
  const meals = mergeRecords(current.meals, incoming.meals);
  const trainings = mergeRecords(current.trainings, incoming.trainings);
  const sleeps = mergeRecords(current.sleeps, incoming.sleeps);
  const exerciseTemplates = [...(current.exerciseTemplates ?? [])];
  for (const template of incoming.exerciseTemplates ?? []) {
    const sameId = exerciseTemplates.find((item) => item.id === template.id);
    if (sameId) {
      if (!equals(sameId, template)) fail('import-conflict', `动作模板内容冲突：${template.name}`);
      continue;
    }
    const sameName = exerciseTemplates.find((item) => item.name.trim().toLocaleLowerCase() === template.name.trim().toLocaleLowerCase());
    if (sameName) {
      if (!equals({ ...sameName, id: '' }, { ...template, id: '' })) fail('import-conflict', `动作模板内容冲突：${template.name}`);
      continue;
    }
    exerciseTemplates.push(template);
  }
  const healthDataChanged = meals.length !== current.meals.length || trainings.length !== current.trainings.length || sleeps.length !== current.sleeps.length || canonicalJson(profileResult) !== canonicalJson(current.profile);
  const mixed = healthDataChanged && (current.meals.length + current.trainings.length + current.sleeps.length > 0);
  const sourceVersion = mixed ? Math.max(current.sourceVersion, incoming.sourceVersion) + 1 : Math.max(current.sourceVersion, incoming.sourceVersion);
  return validateAppData({
    version: 1,
    profile: profileResult,
    meals,
    trainings,
    sleeps,
    ...(exerciseTemplates.length ? { exerciseTemplates } : {}),
    summaries: mixed ? summaries.map((summary) => summary.source === 'ai' ? { ...summary, status: 'stale' as const } : summary) : summaries,
    sourceVersion,
    ...(Object.keys(drafts).length ? { drafts } : {}),
  });
}

export function archiveFileBytes(parsed: ParsedBackup, path: string): Uint8Array | undefined {
  return parsed.media.find((item) => item.path === path)?.bytes;
}
