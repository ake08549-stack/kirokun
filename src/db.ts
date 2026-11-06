import type { HistoryItem } from './types';

const DB_NAME = 'mojioko';
const STORE = 'history';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function saveHistory(item: Omit<HistoryItem, 'id'>): Promise<number> {
  return (await tx('readwrite', (s) => s.add(item))) as number;
}

export async function updateHistory(item: HistoryItem): Promise<void> {
  await tx('readwrite', (s) => s.put(item));
}

export async function listHistory(): Promise<HistoryItem[]> {
  const all = (await tx('readonly', (s) => s.getAll())) as HistoryItem[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteHistory(id: number): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
