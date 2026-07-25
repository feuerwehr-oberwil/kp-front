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
// the offline cache entirely.
//
// The fallback degrades quietly but NOT silently: `idbSet` resolves false when a value could not
// be stored durably anywhere, and `isStorageDegraded()`/`onStorageDegraded()` expose that so the
// UI can tell the operator. Writes that hold operator work must check — see the degraded-storage
// block below for why swallowing it was the dangerous option.

const DB_NAME = 'kp-front'
const DB_VERSION = 1
const STORE = 'kv'

// One shared open request. null until first use; a rejected promise means "IDB unavailable,
// use the localStorage fallback" — we cache that decision so we don't re-probe on every call.
let dbPromise: Promise<IDBDatabase> | null = null
let idbUnavailable = false

// --- Degraded storage -----------------------------------------------------------------
// Set when a write could not be stored durably ANYWHERE (realistically: the origin's quota is
// exhausted). This used to be invisible: idbSet swallowed the failure, `idbUnavailable` was only
// set when the database failed to OPEN — never on a failed transaction — so the store kept its
// PREVIOUS value and the next read served it as if current, including a stale `dirty` flag that
// tells WorkspaceSync there is nothing unsynced to preserve. A tablet with a full disk therefore
// kept accepting edits while quietly recording none of them, which for an incident record is
// worse than a visible crash. Callers now get a boolean and the UI can say so.
let degraded = false
const degradedListeners = new Set<(d: boolean) => void>()
/** keys whose localStorage fallback is known hopeless (payload exceeds the ~5 MB budget), so we
 *  stop paying a large, doomed JSON.stringify on every debounced save. Cleared on any success. */
const noFallback = new Set<string>()

function setDegraded(v: boolean) {
  if (degraded === v) return
  degraded = v
  degradedListeners.forEach((l) => l(v))
}

/** True when a write has failed with nowhere durable to put it. Sticky until a write succeeds. */
export function isStorageDegraded(): boolean {
  return degraded
}

/** Subscribe to degraded-storage transitions. Returns an unsubscribe. */
export function onStorageDegraded(cb: (degraded: boolean) => void): () => void {
  degradedListeners.add(cb)
  return () => degradedListeners.delete(cb)
}

/**
 * Ask the browser to make this origin's storage PERSISTENT (exempt from eviction).
 *
 * Without this the offline cache is "best-effort": the browser may drop the whole bucket under
 * disk pressure — the same loss as a quota failure, except it arrives with no error to catch and
 * nothing to report. For a tool whose premise is an offline-capable incident record on a tablet
 * that may sit unused for months between Einsätze, that is the more likely of the two.
 *
 * Best-effort and non-blocking by contract: callers must NOT await this on the boot path.
 * Resolves false when unsupported or refused.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const s = navigator.storage
    if (!s?.persist || !s.persisted) return false
    return (await s.persisted()) || (await s.persist())
  } catch {
    return false
  }
}

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
//
// TWO distinct fallback situations, deliberately kept in separate key spaces:
//
//  1. IndexedDB won't OPEN at all (Safari private mode, locked-down WebView). localStorage then
//     IS the store, under the PLAIN key — the same key the value used before the IDB migration,
//     so the degraded path stays continuous with pre-migration data.
//  2. IndexedDB opened but a TRANSACTION failed (quota). Here IDB still holds an older copy, so
//     the fallback is a side-store and must not be mistaken for the real thing. It goes under
//     FB_PREFIX. That namespace matters: `idbGet` consults this on an empty read (so the copy is
//     still found after a reload), and without the prefix it would happily return unrelated
//     localStorage entries — the device prefs that live there ON PURPOSE and were never migrated.
const FB_PREFIX = 'kp-idb-fb:'

/** Which key space a localStorage fallback belongs in. Read INSIDE the failure path, never
 *  cached: the very first call after a failed open enters the try with `idbUnavailable` still
 *  false and only learns the truth in its catch, and writing that one value under the prefix
 *  while every later read looked for the plain key would silently strand it. */
const fbKey = (key: string) => (idbUnavailable ? key : FB_PREFIX + key)

const lsGet = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}
/** Returns whether the value actually landed. A workspace blob normally will NOT fit (see the
 *  header: ~5 MB is too small for one), which is precisely why the caller must know. */
const lsSet = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
const lsDel = (key: string): void => {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

// --- Public API: async, structured-clone values, transparent fallback ----------------

/** Read a value (structured-clone object), or null if absent. Never rejects — a storage
 *  failure resolves to null so callers degrade gracefully (the same shape as a cache miss). */
export async function idbGet<T>(key: string): Promise<T | null> {
  if (idbUnavailable) return lsGet<T>(key)
  try {
    const v = await tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
    // An EMPTY IndexedDB read must still consult the quota fallback. A failed transaction routes
    // that write to localStorage, and after a reload nothing in memory remembers which keys — so
    // the old "only fall back when the READ throws" rule made the fallback write-only: the copy
    // was stored and then never found again.
    return v === undefined ? lsGet<T>(fbKey(key)) : v
  } catch {
    return lsGet<T>(key)
  }
}

/**
 * Write a value (stored by structured clone). Resolves **true only if the value is durable**.
 *
 * Fire-and-forget remains fine for callers that genuinely don't care, but anything holding
 * operator work (the workspace cache) must check: a `false` means this edit exists only in page
 * memory and dies with the tab.
 */
export async function idbSet(key: string, value: unknown): Promise<boolean> {
  if (idbUnavailable) {
    const ok = lsSet(key, value)
    if (!ok) setDegraded(true)
    return ok
  }
  try {
    await tx('readwrite', (s) => s.put(value, key))
    noFallback.delete(key)
    setDegraded(false) // a successful write clears the condition
    return true
  } catch {
    // The transaction failed — quota being the realistic cause. IndexedDB still holds the
    // PREVIOUS value for this key, so doing nothing here is what produced the silent stale read.
    if (noFallback.has(key)) { setDegraded(true); return false }
    if (!lsSet(fbKey(key), value)) {
      noFallback.add(key) // too big for localStorage; stop re-stringifying it every save
      setDegraded(true)
      return false
    }
    // The fallback copy is now NEWER than the IndexedDB one. Drop the stale IDB entry so reads
    // resolve to exactly one source of truth (idbGet consults localStorage on an empty read).
    try {
      await tx('readwrite', (s) => s.delete(key))
    } catch {
      setDegraded(true) // both stores disagree and we can't reconcile — say so
    }
    return true
  }
}

/** Delete a key from every store it could be in. Clearing only IndexedDB would leave a quota
 *  fallback copy that `idbGet`'s empty-read path would then resurrect as if it were current. */
export async function idbDel(key: string): Promise<void> {
  noFallback.delete(key)
  lsDel(FB_PREFIX + key) // quota fallback
  lsDel(key)             // IDB-unavailable store
  if (idbUnavailable) return
  try {
    await tx('readwrite', (s) => s.delete(key))
  } catch { /* already absent, or unreachable — the localStorage copy is gone either way */ }
}

/** Test-only: drop the cached open promise so a fresh fake-indexeddb is picked up. */
export function __resetIdbForTests(): void {
  dbPromise = null
  idbUnavailable = false
  degraded = false
  noFallback.clear()
}
