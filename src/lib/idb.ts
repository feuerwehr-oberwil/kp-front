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

import { isUnverifiable } from './api'

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

/** How long `indexedDB.open()` may stay silent. It can — WebKit after a page restore or under
 *  storage pressure, Chromium on a corrupted LevelDB — fire neither `onsuccess` nor `onerror`,
 *  and `onblocked` only fires on a version change (never: DB_VERSION is 1). Every caller awaits
 *  the same cached promise, so one wedged open used to hang the whole boot path behind the
 *  static splash. Past this bound the open counts as failed and the localStorage fallback
 *  takes over, the same degraded path a refused open already lands on. */
const OPEN_TIMEOUT_MS = 5_000

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(e)
      return
    }
    let gaveUp = false
    const timer = setTimeout(() => {
      gaveUp = true
      reject(new Error('IndexedDB open timed out'))
    }, OPEN_TIMEOUT_MS)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      // A connection that arrives after we gave up is closed, not adopted: every caller has
      // already been told to use the fallback namespace, and a late switch would split the
      // store between two backends.
      if (gaveUp) { req.result.close(); return }
      resolve(req.result)
    }
    req.onerror = () => { clearTimeout(timer); reject(req.error) }
    req.onblocked = () => { clearTimeout(timer); reject(new Error('idb blocked')) }
  })
  // Set this in the promise callers await, rather than a detached catch handler. The first
  // operation that observes the failed open must choose the same fallback namespace as every
  // subsequent operation.
  dbPromise = opening.catch((error) => {
    idbUnavailable = true
    throw error
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        let result!: T
        let requestError: DOMException | null = null

        // A request succeeding only means it was accepted by the transaction. The transaction
        // can still abort afterwards (quota, I/O failure, another request), rolling the write
        // back. Resolve only from oncomplete so `idbSet(...).then(true)` means committed.
        req.onsuccess = () => { result = req.result }
        req.onerror = () => { requestError = req.error }
        t.oncomplete = () => requestError ? reject(requestError) : resolve(result)
        t.onerror = () => reject(t.error ?? requestError ?? new Error('IndexedDB transaction failed'))
        t.onabort = () => reject(t.error ?? requestError ?? new Error('IndexedDB transaction aborted'))
      }),
  )
}

// --- localStorage fallback (JSON, since localStorage is string-only) -----------------
//
// Every new fallback write uses one namespaced key, whether IndexedDB failed to open or a
// transaction aborted. Older versions used the plain key when IDB could not open; reads retain
// that path only as a legacy last resort. Keeping new writes in one namespace avoids a first-call
// race and makes the source of truth deterministic across reloads and changing browser modes.
const FB_PREFIX = 'kp-idb-fb:'

type LocalValue<T> = { found: true; value: T } | { found: false }

const lsRead = <T>(key: string): LocalValue<T> => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? { found: false } : { found: true, value: JSON.parse(raw) as T }
  } catch {
    return { found: false }
  }
}
const lsGet = <T>(key: string): T | null => {
  const read = lsRead<T>(key)
  return read.found ? read.value : null
}
/** Returns whether the value actually landed. A workspace blob normally will NOT fit (see the
 *  header: ~5 MB is too small for one), which is precisely why the caller must know. */
const lsSet = (key: string, value: unknown): boolean => {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return false
    localStorage.setItem(key, encoded)
    return true
  } catch {
    return false
  }
}
const lsDel = (key: string): boolean => {
  try {
    localStorage.removeItem(key)
    return localStorage.getItem(key) == null
  } catch {
    // If localStorage is unavailable, it cannot outrank the committed IDB value on reads either.
    return true
  }
}

// --- Public API: async, structured-clone values, transparent fallback ----------------

/** Read a value (structured-clone object), or null if absent. Never rejects — a storage
 *  failure resolves to null so callers degrade gracefully (the same shape as a cache miss). */
export async function idbGet<T>(key: string): Promise<T | null> {
  // A fallback write is canonical until a later IDB transaction commits and removes it. Check
  // it first even when IDB is available: a previous attempt may have committed its request and
  // then aborted, leaving an older IDB value that must never outrank the fallback.
  const fallback = lsRead<T>(FB_PREFIX + key)
  if (fallback.found) return fallback.value
  if (idbUnavailable) return lsGet<T>(key) // legacy failed-open namespace
  try {
    const v = await tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
    const concurrentFallback = lsRead<T>(FB_PREFIX + key)
    if (concurrentFallback.found) return concurrentFallback.value
    return v === undefined ? null : v
  } catch {
    // Re-read in case a concurrent failed write installed the canonical fallback while the IDB
    // read was in flight. The plain key is consulted only after a failed database open.
    const retryFallback = lsRead<T>(FB_PREFIX + key)
    return retryFallback.found ? retryFallback.value : (idbUnavailable ? lsGet<T>(key) : null)
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
  if (!idbUnavailable) {
    try {
      await tx('readwrite', (s) => s.put(value, key))
      // The commit is now the source of truth. Stale fallback data must not survive to outrank it
      // on this or a later page load. The plain key is an old failed-open fallback namespace.
      const clearedFallback = lsDel(FB_PREFIX + key)
      const clearedLegacy = lsDel(key)
      if (!clearedFallback || !clearedLegacy) {
        setDegraded(true)
        return false
      }
      setDegraded(false)
      return true
    } catch {
      // Fall through to the one canonical localStorage namespace. In particular, an individual
      // transaction failure does not make the entire database unavailable.
    }
  }

  if (!lsSet(FB_PREFIX + key, value)) {
    setDegraded(true)
    return false
  }
  setDegraded(false)
  return true
}

/** Delete a key from every store it could be in. Clearing only IndexedDB would leave a quota
 *  fallback copy that `idbGet`'s empty-read path would then resurrect as if it were current. */
export async function idbDel(key: string): Promise<void> {
  lsDel(FB_PREFIX + key) // quota fallback
  lsDel(key)             // IDB-unavailable store
  if (idbUnavailable) return
  try {
    await tx('readwrite', (s) => s.delete(key))
  } catch { /* already absent, or unreachable — the localStorage copy is gone either way */ }
}

// --- Read-through cache --------------------------------------------------------------
//
// Fetch → vet → cache → on failure serve the last copy. Half a dozen call sites hand-rolled
// this and drifted while doing so: some asked `isUnverifiable` (0/502/503/504 — the server
// could not be ASKED), others inlined `status === 0` only, so a Railway restart dropped the
// object listings while leaving the incident list intact. One implementation, one predicate.

/** Where a `readThrough` value came from — `cache` and `fallback` both mean «not fresh». */
export type ReadThroughSource = 'network' | 'cache' | 'fallback'

export interface ReadThroughOptions<T> {
  /** Vets BOTH the fetched value and the stored one. A fetched value that fails is treated as
   *  a miss (the cache, then the fallback, answer) and is never written to the cache — that is
   *  what keeps a corrupt entry from being served as if it were current on the next boot. */
  validate?: (value: unknown) => value is T
  /** Last resort when neither network nor cache produced a usable value. Without one, the
   *  original error is rethrown (or a miss throws), so «no answer at all» stays visible. */
  fallback?: () => T
  /** Which fetch errors may be answered from the cache. Defaults to `isUnverifiable`: silence
   *  falls back, a refusal (401, 404, 500) still throws. Loaders that must NEVER throw pass
   *  `() => true`. */
  shouldFallback?: (error: unknown) => boolean
}

export async function readThrough<T>(
  key: string,
  fetcher: () => Promise<T>,
  { validate, fallback, shouldFallback = isUnverifiable }: ReadThroughOptions<T> = {},
): Promise<{ value: T; source: ReadThroughSource }> {
  const stale = async (rethrow: () => never): Promise<{ value: T; source: ReadThroughSource }> => {
    const cached = await idbGet<unknown>(key)
    if (cached != null && (validate ? validate(cached) : true)) return { value: cached as T, source: 'cache' }
    if (fallback) return { value: fallback(), source: 'fallback' }
    rethrow()
  }
  let fetched: T
  try {
    fetched = await fetcher()
  } catch (e) {
    if (!shouldFallback(e)) throw e
    return stale(() => { throw e })
  }
  if (validate && !validate(fetched)) {
    return stale(() => { throw new Error(`readThrough(${key}): fetched value failed validation`) })
  }
  // fire-and-forget: the caller is waiting on the VALUE, and `idbSet` can sit behind a wedged
  // database open for seconds. A cache that could not be written costs nothing right now.
  void idbSet(key, fetched)
  return { value: fetched, source: 'network' }
}

/** Test-only: drop the cached open promise so a fresh fake-indexeddb is picked up. */
export function __resetIdbForTests(): void {
  dbPromise = null
  idbUnavailable = false
  degraded = false
}
