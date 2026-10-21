import { isAppearanceMode, parseAppearance, serializeAppearance, type AppearanceMode } from './appearance';

export type AppearanceStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  /** Web can restore before the first paint; native storage hydrates asynchronously. */
  readSync?: () => string | null;
};

export type AppearanceSnapshot = Readonly<{
  mode: AppearanceMode;
  ready: boolean;
  saving: boolean;
  error: string;
}>;

const READ_ERROR = '无法读取外观设置，已临时跟随系统。请选择外观模式后重新保存。';
const INVALID_ERROR = '已保存的外观设置无效，已临时跟随系统。请选择外观模式后重新保存。';
const SAVE_ERROR = '外观设置保存失败，请重新选择后重试。';

/** Owns only appearance. Writes are ordered; hydration never replaces a newer choice. */
export function createAppearanceStore(storage: AppearanceStorage) {
  let snapshot: AppearanceSnapshot = Object.freeze({ mode: 'system', ready: false, saving: false, error: '' });
  let committedMode: AppearanceMode = 'system';
  let hydrated = false;
  let loading: Promise<AppearanceSnapshot> | undefined;
  let revision = 0;
  let pendingWrites = 0;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const update = (change: Partial<AppearanceSnapshot>) => {
    const next = { ...snapshot, ...change };
    if (next.mode === snapshot.mode && next.ready === snapshot.ready
      && next.saving === snapshot.saving && next.error === snapshot.error) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) { try { listener(); } catch {} }
  };

  const restore = (raw: string | null) => {
    try { return { mode: parseAppearance(raw), error: '' }; }
    catch { return { mode: 'system' as const, error: INVALID_ERROR }; }
  };

  if (storage.readSync) {
    let restored: { mode: AppearanceMode; error: string };
    try { restored = restore(storage.readSync()); }
    catch { restored = { mode: 'system', error: READ_ERROR }; }
    committedMode = restored.mode;
    hydrated = true;
    update({ ...restored, ready: true });
  }

  const load = (): Promise<AppearanceSnapshot> => {
    if (hydrated) return Promise.resolve(snapshot);
    if (!loading) {
      loading = Promise.resolve().then(async () => {
        let restored: { mode: AppearanceMode; error: string };
        try { restored = restore(await storage.read()); }
        catch { restored = { mode: 'system', error: READ_ERROR }; }
        committedMode = restored.mode;
        hydrated = true;
        // Every write awaits this read. Its result is retained for rollback, while
        // the user's immediate preview takes precedence over a late initial read.
        if (revision === 0) update({ ...restored, ready: true });
        else update({ ready: true });
        return snapshot;
      });
    }
    return loading;
  };

  const setMode = (mode: AppearanceMode): Promise<void> => {
    if (!isAppearanceMode(mode)) return Promise.reject(new Error('请选择有效的外观模式。'));
    const ownRevision = ++revision;
    pendingWrites += 1;
    update({ mode, saving: true, error: '' });
    const task = queue.then(async () => {
      await load();
      try {
        await storage.write(serializeAppearance(mode));
        committedMode = mode;
        if (ownRevision === revision) update({ error: '' });
      } catch {
        if (ownRevision === revision) update({ mode: committedMode, error: SAVE_ERROR });
        throw new Error(SAVE_ERROR);
      } finally {
        pendingWrites -= 1;
        update({ saving: pendingWrites > 0 });
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    setMode,
  };
}

export type AppearanceStore = ReturnType<typeof createAppearanceStore>;
