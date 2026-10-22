import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { type AppData } from './types';
import { BackupError, type BackupMediaInput, type HashBytes, createBackupArchive, parseBackupArchive, remapBackupMedia, collectMediaReferences, collectDraftMediaReferences, canonicalJson, mergeBackupData, mergeFormDrafts, remapDraftMedia, validateAppData, MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES } from './backup';
import { LocalRepository, DATA_KEY, parseLocalSnapshot, type LocalSnapshot } from './local-store';
import { webSnapshotStore, putWebMedia, webMediaKeys, removeWebMedia, clearWebMedia, clearWebDownloads, downloadWebFile } from './storage-web';
import { normalizeMealPhotoDraft } from './meal-photos';

const DRAFT_KEY_PREFIX = '@health-compass/draft-';
const MEDIA_DIR = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}health-compass-media/` : '';
const CACHE_DIR = FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}health-compass/` : '';
const repository = new LocalRepository(Platform.OS === 'web' ? webSnapshotStore : AsyncStorage);
const IMPORT_STATE = Symbol('health-compass-import');
type ImportState = { drafts: Record<string, unknown>; epoch: number; committed: boolean };
type ImportedData = AppData & { [IMPORT_STATE]?: ImportState };
const stagedReferences = new Set<string>();
let deletionEpoch = 0;
// Legacy AsyncStorage keys are migrated once per launch; nothing writes them afterwards.
let legacyMigrated = false;
// Web media keys derived from data URIs. Hashing every photo on each save was the main save cost.
const webMediaKeyCache = new Map<string, string>();

const hashBytes: HashBytes = async (bytes) => {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
};

async function ensureMediaDirectory() {
  if (!MEDIA_DIR) throw new Error('本地文件目录不可用');
  await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
}

async function ensureCacheDirectory(): Promise<void> {
  if (!CACHE_DIR) throw new Error('本地缓存目录不可用');
  await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
}

async function clearOwnedCache(): Promise<void> {
  if (Platform.OS === 'web') { clearWebDownloads(); return; }
  if (CACHE_DIR) await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
  if (FileSystem.cacheDirectory) {
    const names = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    for (const name of names) {
      if (/^(health-compass-backup-|health-summary-)[A-Za-z0-9.-]+\.(zip|json|md)$/.test(name)) await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}`, { idempotent: true });
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) throw new BackupError('invalid-media', '媒体 Base64 数据损坏');
  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output: number[] = [];
  let buffer = 0; let bits = 0;
  for (const char of normalized) {
    if (char === '=') break;
    const index = alphabet.indexOf(char); if (index < 0) continue;
    buffer = (buffer << 6) | index; bits += 6;
    if (bits >= 8) { bits -= 8; output.push((buffer >> bits) & 0xff); }
  }
  return new Uint8Array(output);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1] ?? 0; const c = bytes[i + 2] ?? 0;
    output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? alphabet[c & 63] : '=');
  }
  return output;
}

function parseDataUri(uri: string): Uint8Array | null {
  const match = uri.match(/^data:[^;,]+(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  return match[1] ? base64ToBytes(match[2]) : new TextEncoder().encode(decodeURIComponent(match[2]));
}

async function bytesForUri(uri: string): Promise<Uint8Array> {
  const dataUri = parseDataUri(uri);
  if (dataUri) return dataUri;
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`媒体读取失败（${response.status}）`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const info = await FileSystem.getInfoAsync(uri);
  if (info.exists && info.size > MAX_ARCHIVE_BYTES) throw new BackupError('entry-too-large', '本机文件超过读取大小限制');
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return base64ToBytes(base64);
}

function extensionFor(uri: string, kind: 'image' | 'video', bytes?: Uint8Array) {
  const mimeExtension: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp4': 'mp4' };
  const dataMime = uri.match(/^data:([^;,]+)/)?.[1];
  if (dataMime) return mimeExtension[dataMime] ?? (kind === 'video' ? 'mp4' : 'jpg');
  const uriExtension = uri.match(/\.([A-Za-z0-9]{1,12})(?:[?#].*)?$/)?.[1]?.toLowerCase();
  if (uriExtension) return uriExtension;
  if (bytes) {
    const signature = String.fromCharCode(...bytes.subarray(0, 16));
    if (bytes[0] === 0x89 && signature.slice(1, 4) === 'PNG') return 'png';
    if (signature.startsWith('GIF8')) return 'gif';
    if (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') return 'webp';
    if (signature.slice(4, 8) === 'ftyp') {
      if (signature.includes('avif')) return 'avif';
      if (signature.includes('heic') || signature.includes('heix') || signature.includes('mif1')) return 'heic';
      if (signature.includes('qt  ')) return 'mov';
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  }
  return kind === 'video' ? 'mp4' : 'jpg';
}

function mimeFor(kind: 'image' | 'video', extension: string) {
  if (kind === 'video') return extension === 'mov' ? 'video/quicktime' : extension === 'webm' ? 'video/webm' : 'video/mp4';
  return extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : extension === 'heic' ? 'image/heic' : extension === 'avif' ? 'image/avif' : 'image/jpeg';
}

async function writeDurableMedia(bytes: Uint8Array, kind: 'image' | 'video', extension: string, hash?: string): Promise<string> {
  const digest = hash ?? await hashBytes(bytes);
  const filename = `${kind}-${digest}.${extension}`;
  if (Platform.OS === 'web') {
    const uri = `data:${mimeFor(kind, extension)};base64,${bytesToBase64(bytes)}`;
    await putWebMedia(filename, uri);
    return uri;
  }
  await ensureMediaDirectory();
  const fileUri = `${MEDIA_DIR}${filename}`;
  const info = await FileSystem.getInfoAsync(fileUri);
  if (info.exists) {
    if (await hashBytes(await bytesForUri(fileUri)) !== digest) throw new BackupError('integrity', '本机媒体内容与文件名校验值不一致');
    return fileUri;
  }
  const temporary = `${fileUri}.${Date.now().toString(36)}.tmp`;
  try {
    await FileSystem.writeAsStringAsync(temporary, bytesToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
    if (await hashBytes(await bytesForUri(temporary)) !== digest) throw new BackupError('integrity', '媒体写入校验失败');
    await FileSystem.moveAsync({ from: temporary, to: fileUri });
  } catch (error) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    throw error;
  }
  return fileUri;
}

async function readSnapshot(): Promise<LocalSnapshot> {
  if (legacyMigrated) return repository.read();
  if (Platform.OS === 'web' && await webSnapshotStore.getItem(DATA_KEY) === null) {
    const legacy = await AsyncStorage.getItem(DATA_KEY);
    if (legacy !== null) {
      // Retain the legacy copy until the new durable snapshot has committed successfully.
      await repository.commit(parseLocalSnapshot(legacy));
      await AsyncStorage.removeItem(DATA_KEY);
    }
  }
  const snapshot = await repository.read();
  const keys = await AsyncStorage.getAllKeys();
  const legacyDraftKeys = keys.filter((key) => key.startsWith(DRAFT_KEY_PREFIX));
  if (legacyDraftKeys.length) {
    for (const [key, raw] of await AsyncStorage.multiGet(legacyDraftKeys)) {
      if (raw !== null) {
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new BackupError('invalid-draft', '已有草稿数据损坏，未自动清空'); }
        const kind = key.slice(DRAFT_KEY_PREFIX.length);
        if (kind in snapshot.drafts && canonicalJson(snapshot.drafts[kind]) !== canonicalJson(value)) throw new BackupError('import-conflict', '已有草稿与新存储中的草稿冲突');
        snapshot.drafts[kind] = value;
      }
    }
    await repository.commit(snapshot);
    await AsyncStorage.multiRemove(legacyDraftKeys);
  }
  legacyMigrated = true;
  return snapshot;
}

export async function loadData(): Promise<AppData> {
  return repository.run(async () => {
    const snapshot = await readSnapshot();
    await repository.cleanupBestEffort(() => cleanupMediaImpl(snapshot.data, snapshot.drafts));
    return snapshot.data;
  });
}

export function consumeStorageWarning(): string | undefined {
  return repository.consumeWarning();
}

export async function saveData(data: AppData): Promise<void> {
  const epoch = deletionEpoch;
  await repository.run(async () => {
    if (epoch !== deletionEpoch) throw new BackupError('operation-canceled', '保存已因删除数据取消');
    const snapshot = await readSnapshot();
    const value = validateAppData(data);
    const importState = (data as ImportedData)[IMPORT_STATE];
    if (importState && !importState.committed && importState.epoch !== deletionEpoch) throw new BackupError('operation-canceled', '导入结果已因删除数据取消');
    const drafts = importState && !importState.committed ? importState.drafts : snapshot.drafts;
    const keepIds = new Set([...value.meals, ...value.trainings, ...value.sleeps].map((record) => record.id));
    const removed = [...snapshot.data.meals, ...snapshot.data.trainings, ...snapshot.data.sleeps].filter((record) => !keepIds.has(record.id));
    for (const record of removed) delete drafts[`${record.type}-${record.id}`];
    const removedIds = new Set(removed.map((record) => record.id));
    for (const kind of ['meal', 'training', 'sleep'] as const) {
      const draft = value.drafts?.[kind];
      if (draft?.id && removedIds.has(draft.id)) delete value.drafts![kind];
    }
    if (removed.length) await clearOwnedCache();
    await repository.commit({ storageVersion: 1, data: value, drafts });
    if (importState) importState.committed = true;
    await repository.cleanupBestEffort(async () => {
      for (const reference of [...collectMediaReferences(value), ...collectDraftMediaReferences(drafts)]) stagedReferences.delete(reference.uri);
      await cleanupMediaImpl(value, drafts);
    });
  });
}

export async function clearData(): Promise<void> {
  deletionEpoch++;
  await repository.run(async () => {
    stagedReferences.clear();
    webMediaKeyCache.clear();
    if (Platform.OS === 'web') { await clearWebMedia(); clearWebDownloads(); }
    else {
      if (MEDIA_DIR) await FileSystem.deleteAsync(MEDIA_DIR, { idempotent: true });
      await clearOwnedCache();
    }
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter((key) => key === DATA_KEY || key === `${DATA_KEY}.tmp` || key.startsWith(DRAFT_KEY_PREFIX)));
    await repository.clear();
  });
}

export async function retainMedia(uri: string, kind: 'image' | 'video'): Promise<string> {
  const epoch = deletionEpoch;
  return repository.run(async () => {
    if (epoch !== deletionEpoch) throw new BackupError('operation-canceled', '媒体保存已因删除数据取消');
    if (!uri) throw new Error('媒体 URI 为空');
    const bytes = await bytesForUri(uri);
    if (!bytes.byteLength || bytes.byteLength > MAX_ENTRY_BYTES) throw new Error('媒体为空或超过 128 MB 限制');
    const retained = await writeDurableMedia(bytes, kind, extensionFor(uri, kind, bytes));
    stagedReferences.add(retained);
    return retained;
  });
}

export const persistMedia = retainMedia;

export async function readMediaDataUrl(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  const bytes = await bytesForUri(uri);
  const isVideo = /\.(mp4|mov|webm)(?:[?#]|$)/i.test(uri);
  const kind = isVideo ? 'video' : 'image';
  return `data:${mimeFor(kind, extensionFor(uri, kind))};base64,${bytesToBase64(bytes)}`;
}

async function cleanupMediaImpl(data: AppData, drafts: Record<string, unknown>): Promise<void> {
  const referenced = new Set([...collectMediaReferences(data), ...collectDraftMediaReferences(drafts)].map((entry) => entry.uri));
  for (const uri of stagedReferences) referenced.add(uri);
  if (Platform.OS === 'web') {
    const keepKeys = new Set<string>();
    for (const uri of referenced) {
      let key = webMediaKeyCache.get(uri);
      if (!key) {
        const kind = uri.startsWith('data:video/') ? 'video' : 'image';
        const bytes = parseDataUri(uri);
        if (!bytes) continue;
        key = `${kind}-${await hashBytes(bytes)}.${extensionFor(uri, kind)}`;
        webMediaKeyCache.set(uri, key);
      }
      keepKeys.add(key);
    }
    for (const key of await webMediaKeys()) if (!keepKeys.has(key)) await removeWebMedia(key);
    for (const uri of webMediaKeyCache.keys()) if (!referenced.has(uri)) webMediaKeyCache.delete(uri);
    return;
  }
  if (!MEDIA_DIR) return;
  if (!(await FileSystem.getInfoAsync(MEDIA_DIR)).exists) return;
  const entries = await FileSystem.readDirectoryAsync(MEDIA_DIR);
  await Promise.all(entries.map(async (name) => {
    const uri = `${MEDIA_DIR}${name}`;
    if (!referenced.has(uri)) await FileSystem.deleteAsync(uri, { idempotent: true });
  }));
}

export async function cleanupMedia(data: AppData): Promise<void> {
  await repository.run(async () => cleanupMediaImpl(validateAppData(data), (await readSnapshot()).drafts));
}

export async function exportBackup(data: AppData): Promise<string> {
  const archive = await repository.run(async () => {
    const snapshot = await readSnapshot();
    const valid = validateAppData(data);
    const mediaInputs: BackupMediaInput[] = [];
    for (const ref of [...collectMediaReferences(valid), ...collectDraftMediaReferences(snapshot.drafts)]) {
      try {
        const bytes = await bytesForUri(ref.uri);
        mediaInputs.push({ uri: ref.uri, kind: ref.kind, bytes, extension: extensionFor(ref.uri, ref.kind), mimeType: mimeFor(ref.kind, extensionFor(ref.uri, ref.kind)) });
      } catch (error) {
        throw new BackupError('missing-media', `导出失败：无法读取关联媒体${error instanceof Error ? `（${error.message}）` : ''}`);
      }
    }
    return createBackupArchive(valid, mediaInputs, undefined, { hash: hashBytes, drafts: snapshot.drafts });
  });
  const name = `health-compass-backup-${Date.now()}.zip`;
  if (Platform.OS === 'web') return downloadWebFile(archive, name, 'application/zip');
  await ensureCacheDirectory();
  const uri = `${CACHE_DIR}${name}`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(archive), { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: '导出有节备份' });
  return uri;
}

async function pickedBytes(asset: DocumentPicker.DocumentPickerAsset): Promise<Uint8Array> {
  if (asset.size && asset.size > MAX_ARCHIVE_BYTES) throw new BackupError('archive-too-large', '备份文件超过 256 MB 限制');
  if (asset.base64) return base64ToBytes(asset.base64);
  if (asset.file) return new Uint8Array(await asset.file.arrayBuffer());
  return bytesForUri(asset.uri);
}

/** Validate, merge, and stage everything. Only the caller's subsequent saveData commits the new snapshot. */
export async function importBackup(current?: AppData): Promise<AppData | null> {
  const epoch = deletionEpoch;
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], copyToCacheDirectory: true, base64: false });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const parsed = await (async () => {
    try { return await parseBackupArchive(await pickedBytes(asset), { hash: hashBytes }); }
    finally {
      if (Platform.OS !== 'web' && FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined);
    }
  })();
  return repository.run(async () => {
    if (epoch !== deletionEpoch) throw new BackupError('operation-canceled', '导入已因删除数据取消');
    const snapshot = await readSnapshot();
    const currentData = validateAppData(current ?? snapshot.data);
    const aliases = new Map<string, string>();
    for (const media of parsed.media) aliases.set(media.path, `${media.kind}:${media.sha256}`);
    for (const ref of [...collectMediaReferences(currentData), ...collectDraftMediaReferences(snapshot.drafts)]) {
      aliases.set(ref.uri, `${ref.kind}:${await hashBytes(await bytesForUri(ref.uri))}`);
    }
    const equivalent = (left: unknown, right: unknown) => canonicalJson(left, aliases) === canonicalJson(right, aliases);
    mergeBackupData(currentData, parsed.data, equivalent);
    mergeFormDrafts(snapshot.drafts, parsed.drafts, equivalent);
    const replacements = new Map<string, string>();
    const created: Array<{ uri: string; key: string }> = [];
    const oldWebKeys = Platform.OS === 'web' ? new Set(await webMediaKeys()) : new Set<string>();
    try {
      for (const media of parsed.media) {
        const key = `${media.kind}-${media.sha256}.${media.extension}`;
        const existed = Platform.OS === 'web' ? oldWebKeys.has(key) : (await FileSystem.getInfoAsync(`${MEDIA_DIR}${key}`)).exists;
        const target = await writeDurableMedia(media.bytes, media.kind, media.extension, media.sha256);
        aliases.set(target, `${media.kind}:${media.sha256}`);
        replacements.set(media.path, target);
        if (!existed) created.push({ uri: target, key });
      }
      if (epoch !== deletionEpoch) throw new BackupError('operation-canceled', '导入已因删除数据取消');
      const restored = remapBackupMedia(parsed.data, replacements);
      const imported = mergeBackupData(currentData, restored, equivalent);
      const drafts = mergeFormDrafts(snapshot.drafts, remapDraftMedia(parsed.drafts, replacements), equivalent);
      // Symbols survive the caller's object spread/summary refresh and are excluded from JSON data.
      (imported as ImportedData)[IMPORT_STATE] = { drafts, epoch, committed: false };
      for (const uri of replacements.values()) stagedReferences.add(uri);
      return imported;
    } catch (error) {
      for (const item of created) {
        if (Platform.OS === 'web') await removeWebMedia(item.key).catch(() => undefined);
        else await FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function exportDailyMarkdown(data: AppData, date: string): Promise<void> {
  const candidates = data.summaries.filter((item) => item.date === date).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const summary = candidates.find((item) => item.source === 'ai' && item.status === 'current') ?? candidates.find((item) => item.source === 'local') ?? candidates[0];
  if (!summary) throw new Error(`没有 ${date} 的每日总结`);
  const bytes = new TextEncoder().encode(summary.markdown);
  if (Platform.OS === 'web') {
    downloadWebFile(bytes, `health-summary-${date}.md`, 'text/markdown;charset=utf-8');
    return;
  }
  await ensureCacheDirectory();
  const uri = `${CACHE_DIR}health-summary-${date}.md`;
  await FileSystem.writeAsStringAsync(uri, summary.markdown);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'text/markdown', dialogTitle: '导出每日总结' });
}

export async function saveDraft(kind: string, value: unknown): Promise<void> {
  const epoch = deletionEpoch;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(kind)) throw new Error('草稿类型不合法');
  await repository.run(async () => {
    if (epoch !== deletionEpoch) throw new BackupError('operation-canceled', '草稿保存已因删除数据取消');
    const snapshot = await readSnapshot();
    snapshot.drafts[kind] = value;
    await repository.commit(snapshot);
    await repository.cleanupBestEffort(async () => {
      for (const ref of collectDraftMediaReferences(snapshot.drafts)) stagedReferences.delete(ref.uri);
      await cleanupMediaImpl(snapshot.data, snapshot.drafts);
    });
  });
}

export async function loadDraft<T>(kind: string): Promise<T | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(kind)) throw new Error('草稿类型不合法');
  return repository.run(async () => {
    const draft = (await readSnapshot()).drafts[kind] ?? null;
    return (kind === 'meal' || kind.startsWith('meal-') ? normalizeMealPhotoDraft(draft) : draft) as T | null;
  });
}

export async function clearDraft(kind: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(kind)) throw new Error('草稿类型不合法');
  await repository.run(async () => {
    const snapshot = await readSnapshot();
    delete snapshot.drafts[kind];
    await repository.commit(snapshot);
    await repository.cleanupBestEffort(() => cleanupMediaImpl(snapshot.data, snapshot.drafts));
  });
}

export { BackupError };
