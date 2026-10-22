import type { Pattern } from './types';

/**
 * Everything lives in IndexedDB on the phone. Patterns are stored without their image (kept
 * in a separate store) so saving progress after every few stitches stays cheap.
 */
const DB_NAME = 'cross-stitch-helper';
const PATTERNS = 'patterns';
const IMAGES = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(PATTERNS, { keyPath: 'id' });
      req.result.createObjectStore(IMAGES);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listPatterns(): Promise<Pattern[]> {
  const db = await open();
  const all = await wrap(db.transaction(PATTERNS).objectStore(PATTERNS).getAll() as IDBRequest<Pattern[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

export async function getPattern(id: string): Promise<Pattern | undefined> {
  const db = await open();
  return wrap(db.transaction(PATTERNS).objectStore(PATTERNS).get(id) as IDBRequest<Pattern | undefined>);
}

export async function getImage(id: string): Promise<Blob | undefined> {
  const db = await open();
  return wrap(db.transaction(IMAGES).objectStore(IMAGES).get(id) as IDBRequest<Blob | undefined>);
}

export async function savePattern(p: Pattern, image?: Blob): Promise<void> {
  const db = await open();
  const tx = db.transaction([PATTERNS, IMAGES], 'readwrite');
  tx.objectStore(PATTERNS).put(p);
  if (image) tx.objectStore(IMAGES).put(image, p.id);
  await done(tx);
}

export async function deletePattern(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([PATTERNS, IMAGES], 'readwrite');
  tx.objectStore(PATTERNS).delete(id);
  tx.objectStore(IMAGES).delete(id);
  await done(tx);
}

/** Asks the browser not to evict our data when storage is tight. Best effort. */
export function requestPersistence(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}
