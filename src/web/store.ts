/**
 * The phone's vault: every file in IndexedDB, keyed by vault path, plus a small key-value table
 * for settings and sync state. The service worker opens the same database to serve attachments.
 */

export interface StoredFile {
  path: string;
  bytes: Uint8Array;
  mtime: number;
  hash: string;
}

const DB = "railnote";
const FILES = "files";
const KV = "kv";

let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FILES, { keyPath: "path" });
      req.result.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await open();
  return wrap(fn(d.transaction(store, mode).objectStore(store)));
}

export const files = {
  all: () => tx<StoredFile[]>(FILES, "readonly", (s) => s.getAll()),
  get: (path: string) => tx<StoredFile | undefined>(FILES, "readonly", (s) => s.get(path)),
  put: (f: StoredFile) => tx(FILES, "readwrite", (s) => s.put(f)),
  delete: (path: string) => tx(FILES, "readwrite", (s) => s.delete(path)),
};

export const kv = {
  get: <T>(key: string) => tx<T | undefined>(KV, "readonly", (s) => s.get(key)),
  set: (key: string, value: unknown) => tx(KV, "readwrite", (s) => s.put(value, key)),
  delete: (key: string) => tx(KV, "readwrite", (s) => s.delete(key)),
};

/** Asks the browser not to clear this site's storage when space runs low. */
export function keepStorage() {
  return navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false);
}
