import { BackupError, validateAppData, validateFormDrafts } from './backup';
import { emptyData, type AppData } from './types';

export type LocalSnapshot = { storageVersion: 1; data: AppData; drafts: Record<string, unknown> };
export type SnapshotStore = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };

export const DATA_KEY = '@health-compass/data-v1';
const TEMP_KEY = `${DATA_KEY}.tmp`;

export function parseLocalSnapshot(raw: string | null): LocalSnapshot {
  if (raw === null) return { storageVersion: 1, data: emptyData(), drafts: {} };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BackupError('invalid-data', '本机数据损坏，未自动清空，以保留原始存储。'); }
  if (value && typeof value === 'object' && 'storageVersion' in value) {
    const snapshot = value as { storageVersion: unknown; data: unknown; drafts: unknown };
    if (snapshot.storageVersion !== 1) throw new BackupError('unsupported-version', '本机存储版本不受支持，未自动清空');
    return { storageVersion: 1, data: validateAppData(snapshot.data), drafts: validateFormDrafts(snapshot.drafts) };
  }
  return { storageVersion: 1, data: validateAppData(value), drafts: {} };
}

/** One committed key makes data and form drafts an atomic replacement. Failed staging never touches it. */
export class LocalRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private warning: string | undefined;
  constructor(private readonly store: SnapshotStore) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async read(): Promise<LocalSnapshot> {
    return parseLocalSnapshot(await this.store.getItem(DATA_KEY));
  }

  async cleanupBestEffort(cleanup: () => Promise<void>): Promise<void> {
    try {
      await cleanup();
      this.warning = undefined;
    } catch {
      this.warning = '媒体清理未完成，已保存的数据不受影响。稍后将重试。';
    }
  }

  consumeWarning(): string | undefined {
    const warning = this.warning;
    this.warning = undefined;
    return warning;
  }

  async commit(snapshot: LocalSnapshot): Promise<void> {
    const safe: LocalSnapshot = { storageVersion: 1, data: validateAppData(snapshot.data), drafts: validateFormDrafts(snapshot.drafts) };
    const serialized = JSON.stringify(safe);
    await this.store.setItem(TEMP_KEY, serialized);
    try { await this.store.setItem(DATA_KEY, serialized); }
    catch (error) { await this.store.removeItem(TEMP_KEY).catch(() => undefined); throw error; }
    // An interrupted cleanup leaves an ignored candidate, never a partially committed snapshot.
    await this.store.removeItem(TEMP_KEY).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await this.store.removeItem(DATA_KEY);
    await this.store.removeItem(TEMP_KEY);
  }
}
