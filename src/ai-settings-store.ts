import { AI_REQUEST_TIMEOUT_MS, MAX_MEAL_ANALYSIS_STAGES, validateAiSettings } from './ai-provider';
import type { AiSettings } from './ai-provider';

export type AiSettingsStorage = { read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void> };

export function createAiSettingsStore(storage: AiSettingsStorage) {
  let current: AiSettings | null = null;
  let loaded = false;
  let version = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const snapshot = () => current ? { ...current } : null;
  const invalidate = () => { version += 1; for (const listener of listeners) { try { listener(); } catch {} } };
  function ordered<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  return {
    get: snapshot,
    version: () => version,
    subscribe,
    load: () => ordered(async () => {
      if (loaded) return snapshot();
      let raw: string | null;
      try { raw = await storage.read(); }
      catch { throw new Error('无法读取本机保存的 AI 设置，请重试。'); }
      let next: AiSettings | null;
      try { next = raw === null ? null : validateAiSettings(JSON.parse(raw)); }
      catch { throw new Error('已保存的 AI 设置无效，请重新配置或清除。'); }
      current = next; loaded = true; invalidate();
      return snapshot();
    }),
    save: (settings: AiSettings) => {
      const valid = validateAiSettings(settings);
      invalidate();
      return ordered(async () => {
        try { await storage.write(JSON.stringify(valid)); }
        catch { throw new Error('无法将 AI 设置保存到本机，原配置已保留，请重试。'); }
        current = valid; loaded = true; invalidate();
      });
    },
    clear: () => {
      invalidate();
      return ordered(async () => {
        try { await storage.remove(); }
        catch { throw new Error('无法清除本机的 AI 设置，原配置已保留，请重试。'); }
        current = null; loaded = true; invalidate();
      });
    },
    beginRequest: (externalSignal?: AbortSignal) => {
      const settings = snapshot();
      if (!settings) throw new Error('AI 服务尚未连接，原始记录已保留。');
      const revision = version;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const unsubscribe = subscribe(abort);
      externalSignal?.addEventListener('abort', abort, { once: true });
      if (externalSignal?.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort(); }, AI_REQUEST_TIMEOUT_MS * MAX_MEAL_ANALYSIS_STAGES + 5_000);
      return {
        settings,
        signal: controller.signal,
        assertCurrent: () => {
          if (revision !== version) throw new Error('AI 配置已更改，本次分析未保存。');
          if (controller.signal.aborted) throw new Error(timedOut ? '分析等待超时，记录已保留。' : '分析已取消，记录已保留。');
        },
        dispose: () => { clearTimeout(timer); unsubscribe(); externalSignal?.removeEventListener('abort', abort); },
      };
    },
  };
}
