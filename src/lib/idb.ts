// Operational browser storage. Per the architecture decision: incident workspaces, the
// cached incident list, pending sync
// state, roster/config/identity caches, and map/outline caches live in IndexedDB — NOT
// localStorage, whose ~5 MB string-only budget is too small for a full offline incident
// workspace. localStorage stays only for tiny device prefs (the prefs cookie) and one-time
// migration flags.
//
// This is a deliberately tiny promise-wrapped key-value store over a single object store —
// no external dependency (the project keeps deps lean) and no schema/versioning ceremony,
// because callers already treat their values as opaque blobs keyed by string (mirroring the
// localStorage keys they replace). Values are stored by structured clone (native objects),
// so a large workspace isn't paying a JSON.stringify/parse round-trip on every save.
//
// Robustness for the field: if IndexedDB can't be opened at all (Safari private mode has
// historically disabled it; locked-down WebViews; disk-full), every call transparently
// falls back to localStorage with JSON serialization, so the app degrades instead of losing
// the offline cache entirely. The fallback is per-call and silent — the app keeps working.

const DB_NAME = 'kp-front'
const DB_VERSION = 1
const STORE = 'kv'

// One shared open request. null until first use; a rejected promise means "IDB unavailable,
// use the localStorage fallback" — we cache that decision so we don't re-probe on every call.
let dbPromise: Promise<IDBDatabase> | null = null
let idbUnavailable = false

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(e)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('idb blocked'))
  })
  // Mark IDB unavailable on a failed open so subsequent calls skip straight to the fallback.
  dbPromise.catch(() => { idbUnavailable = true })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// --- localStorage fallback (JSON, since localStorage is string-only) -----------------
const lsGet = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}
const lsSet = (key: string, value: unknown): void => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota — server is authoritative */ }
}

// --- Public API: async, structured-clone values, transparent fallback ----------------

/** Read a value (structured-clone object), or null if absent. Never rejects — a storage
 *  failure resolves to null so callers degrade gracefully (the same shape as a cache miss). */
export async function idbGet<T>(key: string): Promise<T | null> {
  if (idbUnavailable) return lsGet<T>(key)
  try {
    const v = await tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
    return v === undefined ? null : v
  } catch {
    return lsGet<T>(key)
  }
}

/** Write a value (stored by structured clone). Fire-and-forget at call sites that don't await;
 *  swallows storage errors (quota / unavailable) like the old localStorage writes did. */
export async function idbSet(key: string, value: unknown): Promise<void> {
  if (idbUnavailable) return lsSet(key, value)
  try {
    await tx('readwrite', (s) => s.put(value, key))
  } catch {
    lsSet(key, value)
  }
}

/** Delete a key. */
export async function idbDel(key: string): Promise<void> {
  if (idbUnavailable) { try { localStorage.removeItem(key) } catch { /* ignore */ } return }
  try {
    await tx('readwrite', (s) => s.delete(key))
  } catch {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }
}

/** Test-only: drop the cached open promise so a fresh fake-indexeddb is picked up. */
export function __resetIdbForTests(): void {
  dbPromise = null
  idbUnavailable = false
}
