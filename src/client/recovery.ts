/**
 * Crash and close recovery: the open project is written to IndexedDB (this browser profile,
 * this machine only) a moment after each change, in the same format as a saved .clarity file.
 * It is offered back on the next launch. It is a safety net, not a replacement for Save.
 */
const DB = 'hcg-clarity';
const STORE = 'recovery';
const KEY = 'current';

export interface RecoveryRecord {
  title: string;
  savedAt: string;
  bytes: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available.'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function writeRecovery(rec: RecoveryRecord): Promise<void> {
  await run('readwrite', (s) => s.put(rec, KEY));
}

export async function readRecovery(): Promise<RecoveryRecord | null> {
  try {
    const r = await run<RecoveryRecord | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<RecoveryRecord | undefined>);
    return r && r.bytes instanceof Uint8Array ? r : null;
  } catch {
    return null;
  }
}

export async function clearRecovery(): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing to clear */
  }
}
