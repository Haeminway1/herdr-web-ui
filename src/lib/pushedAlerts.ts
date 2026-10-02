import { validTime, type NewAlert } from "./alertLog.ts";

/**
 * The pushes the service worker showed (public/sw.js writes them, the names match there). A push
 * that arrives while no page of the app runs is heard nowhere else, so the bell's list
 * (lib/alertLog.ts) would never learn of it. The page takes them out once it is on screen.
 */

export const PUSHED_DB = "herdr-web-ui-alerts";
export const PUSHED_STORE = "pushed";

/** One record as the worker wrote it, or null for anything else. */
export function pushedAlert(value: unknown): NewAlert | null {
  const record = value as { at?: unknown; machineId?: unknown; paneId?: unknown; title?: unknown; kind?: unknown } | null;
  if (typeof record !== "object" || record === null) return null;
  const { at, machineId, paneId, title, kind } = record;
  if (!validTime(at) || typeof machineId !== "string" || typeof paneId !== "string" || typeof title !== "string") return null;
  if (kind !== "blocked" && kind !== "done" && kind !== "ended") return null;
  return { at, machineId, paneId, agent: null, title, machine: null, kind };
}

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idb.open(PUSHED_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(PUSHED_STORE, { autoIncrement: true }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Reads and empties the store in one transaction, so of two tabs only one takes each alert (the
 * other hears of it through the list's storage event).
 */
export async function takePushedAlerts(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<NewAlert[]> {
  if (!idb) return [];
  const db = await open(idb);
  try {
    return await new Promise<NewAlert[]>((resolve, reject) => {
      const tx = db.transaction(PUSHED_STORE, "readwrite");
      const store = tx.objectStore(PUSHED_STORE);
      const all = store.getAll();
      store.clear();
      tx.oncomplete = () => resolve((all.result as unknown[]).flatMap((value) => pushedAlert(value) ?? []));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Signing out forgets them too: they name the panes of whoever was signed in. */
export async function clearPushedAlerts(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return;
  const db = await open(idb);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PUSHED_STORE, "readwrite");
      tx.objectStore(PUSHED_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
