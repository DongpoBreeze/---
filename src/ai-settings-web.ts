import type { AiSettingsStorage } from './ai-settings-store';

// Keep credentials outside the health snapshot database and its ZIP exports.
const DATABASE_NAME = 'health-compass-ai-settings-v1';
const STORE_NAME = 'settings';
const KEY = 'health-compass.ai-settings.v1';

export function createWebAiSettingsStorage(): AiSettingsStorage {
  let opening: Promise<IDBDatabase> | undefined;

  function database(): Promise<IDBDatabase> {
    if (opening) return opening;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('当前浏览器不支持本机配置存储。'));
        return;
      }
      const request = indexedDB.open(DATABASE_NAME, 1);
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('无法打开浏览器中的本机 AI 配置存储。'));
      };
      const timer = setTimeout(fail, 10_000);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = () => { db.close(); opening = undefined; };
        db.onclose = () => { opening = undefined; };
        resolve(db);
      };
      request.onerror = fail;
      request.onblocked = fail;
    });
    opening = attempt;
    void attempt.catch(() => { if (opening === attempt) opening = undefined; });
    return attempt;
  }

  async function transaction<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error('浏览器中的本机 AI 配置读写失败。'));
      try {
        const request = execute(tx.objectStore(STORE_NAME));
        request.onsuccess = () => { result = request.result; };
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  return {
    async read() { return await transaction<string | undefined>('readonly', (store) => store.get(KEY)) ?? null; },
    async write(value) { await transaction('readwrite', (store) => store.put(value, KEY)); },
    async remove() { await transaction('readwrite', (store) => store.delete(KEY)); },
  };
}

export const webAiSettingsStorage = createWebAiSettingsStorage();
