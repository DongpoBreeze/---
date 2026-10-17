import { BackupError } from './backup';
import type { SnapshotStore } from './local-store';

const DATABASE_NAME = 'health-compass-local-v1';
let opening: Promise<IDBDatabase> | undefined;
const downloadUrls = new Set<string>();

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new BackupError('storage-unavailable', '当前浏览器不支持本地持久存储')); return; }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
    request.onerror = () => { opening = undefined; reject(request.error ?? new Error('浏览器本地存储打开失败')); };
    request.onblocked = () => { opening = undefined; reject(new Error('浏览器本地存储被其他窗口阻塞')); };
  });
  return opening;
}

async function transaction<T>(store: 'snapshots' | 'media', mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = execute(tx.objectStore(store));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('浏览器存储空间不足或写入失败'));
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error('浏览器本地存储操作失败'));
  });
}

export const webSnapshotStore: SnapshotStore = {
  async getItem(key) { return await transaction('snapshots', 'readonly', (store) => store.get(key)) ?? null; },
  async setItem(key, value) { await transaction('snapshots', 'readwrite', (store) => store.put(value, key)); },
  async removeItem(key) { await transaction('snapshots', 'readwrite', (store) => store.delete(key)); },
};

export async function putWebMedia(key: string, dataUrl: string): Promise<void> {
  await transaction('media', 'readwrite', (store) => store.put(dataUrl, key));
}

export async function webMediaKeys(): Promise<string[]> {
  return (await transaction('media', 'readonly', (store) => store.getAllKeys())).map(String);
}

export async function removeWebMedia(key: string): Promise<void> {
  await transaction('media', 'readwrite', (store) => store.delete(key));
}

export async function clearWebMedia(): Promise<void> {
  await transaction('media', 'readwrite', (store) => store.clear());
}

export function clearWebDownloads(): void {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
}

export function downloadWebFile(bytes: Uint8Array, name: string, mimeType: string): string {
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  downloadUrls.add(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 60_000);
  return url;
}
