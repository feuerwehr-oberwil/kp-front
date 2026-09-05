// Per-incident sync engine: offline cache (IndexedDB) + debounced last-write-wins save with a
// three-way merge on conflict. Split out of the incidents data layer because it's the single
// heaviest, most stateful unit — see ./workspace for the plain get/put the engine drives.
import { ApiError } from '../api'
import { idbDel, idbGet, idbSet } from '../idb'
import { withTileEviction } from '../tileEvict'
import { mergeWorkspace, type RecordConflict } from '../mergeWorkspace'
import {
  getWorkspace, putWorkspace, putWorkspaceBeacon, putWorkspaceTrupps, putWorkspaceTruppsBeacon,
  type Workspace,
} from './workspace'
import type { Trupp } from '../../types'

// --- Workspace sync: offline cache + debounced save with three-way merge -------------
// `base` is the last server revision we shared with everyone else — the common ancestor a
// conflict merges against (see mergeWorkspace). It rides the cache so an offline edit still
// has an ancestor to merge from on reconnect.
type CacheEntry = {
  workspace: Workspace
  baseRev: number
  dirty: boolean
  lastSyncedAt: number | null
  base?: Workspace
  /** WHO this entry belongs to (AuthUser.id), captured when the entry was BUILT or last edited —
   *  never re-stamped from the live session at write time, so a debounced/teardown write that
   *  lands after the identity changed still says whose work it is. An entry without one predates
   *  ownership (see `loadReadableEntry` for how it is adopted or preserved). */
  owner?: string
}
const cacheKey = (id: string) => `kp-front-ws-${id}`
// A fallback slot, one per (incident, owner). Another user's UNSYNCED work is parked here so the
// main slot can be reused without destroying it, and so its owner recovers it on their next
// sign-in (see loadReadableEntry). NEVER read across owners — the key IS the ownership proof.
const ownerCacheKey = (id: string, owner: string) => `kp-front-ws-${id}::${owner}`
// The orphan slot: unsynced work that carries NO owner — every entry written before ownership
// existed (this batch), when an online upgrade would otherwise let a clean server fetch overwrite
// the only unsynced copy. It is unattributable, so it is NEVER served (we can't prove who wrote
// it), but it is also never destroyed: it is parked here before the slot is reused, and recovered
// by hand from this key (there is deliberately no auto-restore — see loadReadableEntry). First
// writer wins, so an already-parked orphan (the real pre-upgrade copy) is never clobbered.
const orphanCacheKey = (id: string) => `kp-front-ws-${id}::__preupgrade__`

// --- Who may read this device's offline cache ----------------------------------------
// The cache is the product's core promise, so exactly two things close it, and NEITHER of them
// is a lost connection: a session a reachable server has explicitly refused (SEC-10 — a revoked
// or signed-out login must not keep reading the device's copy), and a cache another user filled.
// Silence — airplane mode, a restarting server — refuses nothing and still reads.
//
// Device state, not per-instance: one engine exists per open incident, but the answer is about
// the browser session. lib/auth is the only writer, because it is the only place that knows.
let cacheOwner: string | null = null
let cacheDenied = false

/** The signed-in user settled (boot probe, login, logout). A real user id also LIFTS a denial —
 *  the account is back, and the edits it left behind are its own again; `null` only drops
 *  ownership, so a logout keeps the lock it set. */
export function setWorkspaceCacheOwner(userId: string | null): void {
  cacheOwner = userId
  if (userId) cacheDenied = false
}

/** A reachable server explicitly refused this session (401 / logout). Cached workspaces stop
 *  being readable at once. Nothing is deleted: unsynced edits stay on the device and are handed
 *  back the moment the same user signs in — writing is never locked, only reading. */
export function denyWorkspaceCache(): void {
  cacheDenied = true
}

/** May this session be answered from what the cache holds, as-is? A refusal closes every read.
 *
 *  The two guarantees this balances: offline-first (a device reopened with no reachable server
 *  must still show its own last work) and cross-user isolation (a DIFFERENT signed-in user must
 *  never read or inherit another's cache). They only ever collide once a competing identity
 *  exists — so ownership gates reads ONLY when an owner has actually settled:
 *    · denied            → false. A reachable server said «no»; this is the SEC-10 lock.
 *    · no settled owner  → true. Boot before /me resolves, or offline where it can't: there is
 *                          no other identity to protect against, so the device reads its own
 *                          cache (auth gates the moment a user — the same or a different one —
 *                          settles). Physical-device access with no login is the accepted
 *                          "device loss is operational" boundary, unchanged from before the batch.
 *    · owner settled     → an ownerless entry is NOT blind-served (loadReadableEntry adopts it if
 *                          clean, preserves it if dirty); an owned entry is served only to its
 *                          owner. */
function mayRead(entry: CacheEntry): boolean {
  if (cacheDenied) return false
  if (!cacheOwner) return true
  if (!entry.owner) return false
  return entry.owner === cacheOwner
}

/** Did the server ANSWER «no», as opposed to not answering at all (api · isUnverifiable)? Only
 *  this closes the offline fallback; every other failure keeps the device usable. */
function isDenial(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403)
}
/** how long after the last save() the offline cache write waits for the next one */
export const CACHE_DEBOUNCE_MS = 300

function readCache(id: string): Promise<CacheEntry | null> {
  return idbGet<CacheEntry>(cacheKey(id))
}
// NOTE: the per-instance writer is `this.writeCache` below — it keeps the durability of each
// write, which a bare fire-and-forget threw away. "Non-fatal because the server is authoritative"
// holds only while we ARE reaching the server; offline it is the difference between an edit that
// survives teardown and one that doesn't.

/** Drop one incident's offline cache. DESTRUCTIVE: any edit that hasn't reached the server yet
 *  lives only here. The single caller is the ErrorBoundary's last-resort recovery — when the
 *  cached blob is what crashes the render, this is the only way back in from the device itself
 *  (the next open re-pulls from the server). */
export function discardWorkspaceCache(id: string): Promise<void> {
  return idbDel(cacheKey(id))
}

/** Lifecycle of the per-incident sync, surfaced to the UI so unsynced/offline/error
 *  states are never silent: `synced` = server has our latest; `pending` = local edits
 *  not yet flushed; `offline` = a flush failed on the network (cached locally, will
 *  retry); `error` = a flush failed for another reason (also cached, also retried);
 *  `storage` = the offline cache itself refused the write, so unsynced edits are NOT
 *  "cached locally, will retry" — they live only in this tab. See effectiveSyncStatus. */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error' | 'storage'

/**
 * Collapse the sync lifecycle and the durability of the local cache into the one state the UI
 * shows. `storage` outranks everything else, but ONLY while there are unsynced edits.
 *
 * That condition is the whole point. Every other status quietly promises "your work is cached
 * and will be retried" — a promise a full storage bucket breaks, turning "will sync later" into
 * "will be lost on teardown", which the operator must see. But when the server already has our
 * latest, a cache that can't write costs nothing right now; it only means this device is not
 * offline-READY. Shouting then would be crying wolf, and the Offline-Bereitschaft sheet is the
 * honest place for it (it reports device readiness, which is exactly what's degraded).
 */
export function effectiveSyncStatus(base: SyncStatus, dirty: boolean, cacheDurable: boolean): SyncStatus {
  return !cacheDurable && dirty ? 'storage' : base
}

export interface WorkspaceSyncOptions {
  /** called whenever the synced revision changes (e.g. to update UI badges). */
  onRev?: (rev: number) => void
  /** called with the authoritative workspace when it must replace local state out-of-band
   *  (fallback when no in-place applier is registered — triggers a full remount). */
  onServerWorkspace?: (ws: Workspace, rev: number) => void
  /** called after a 409 was auto-merged, so the app can show a non-blocking notice. */
  onMerged?: () => void
  debounceMs?: number
  /**
   * Push only ONE slice of the blob instead of the whole document.
   *
   * `'trupps'` is the Atemschutz-Link session (auth · AuthUser.link_kind): it may write the
   * Überwachungstafel and nothing else, so the full workspace PUT 403s for it. Only the push
   * and the teardown beacon change — the cache, the debounce, the three-way merge on 409, the
   * retry backoff and the live-follow poll are the same engine, because the merge still has to
   * reason about the WHOLE blob (the server's copy carries everything).
   */
  slice?: 'trupps'
}

/** The trupp slice of an opaque workspace blob. The engine treats the blob as data it only
 *  moves, so this is the one place that looks inside it — absent or malformed reads as «no
 *  Trupps», which is what a fresh Einsatz genuinely has. */
function truppSlice(ws: Workspace): readonly Trupp[] {
  const t = ws.trupps
  return Array.isArray(t) ? (t as Trupp[]) : []
}

/**
 * Per-incident sync engine. The App calls `save(workspace)` on every edit (replacing the
 * old direct localStorage write); we cache instantly, mark dirty, and flush to the server
 * debounced. `init()` loads from server (falling back to the offline cache).
 */
export class WorkspaceSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** the offline-cache write waiting for the keystrokes to stop — see writeCache */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  private entry: CacheEntry
  private flushing = false
  private disposed = false
  private saveSeq = 0 // bumped on each save(); lets a flush detect an edit that landed mid-PUT
  private readonly debounceMs: number
  // Automatic retry after a FAILED flush (server 5xx / network drop): without it a dirty
  // workspace on an idle device stays unsynced forever — the live-poll gates on !hasUnsynced,
  // so it stops pulling too — until the operator happens to edit again. Exponential backoff,
  // reset on any successful push.
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  /** Registered by the live view to apply a merged/authoritative workspace IN PLACE (no
   *  remount), so an auto-merged conflict surfaces the other device's edits smoothly. Falls
   *  back to onServerWorkspace (a remount) when unset. */
  onApplyMerged?: (ws: Workspace, rev: number) => void
  /** Registered by the live view to reflect the sync lifecycle in the UI (status badge).
   *  Set after construction (like onApplyMerged); read the initial value via `syncStatus`. */
  onStatus?: (status: SyncStatus) => void
  /** Registered by the live view (useIncidentSync): a three-way merge saw BOTH sides change
   *  the SAME person's attendance to different values (LWW kept) — the caller appends one
   *  Verlauf note per person. Conflicts found before registration (init()'s cold-reopen
   *  merge) buffer until the first registration/drain. */
  onAttendanceConflicts?: (conflicts: RecordConflict[]) => void
  private conflictBuf: RecordConflict[] = []
  /** Registered by the live view (useIncidentSync): a three-way merge saw BOTH sides change
   *  the SAME Trupp concurrently. The merge itself is field-level (mergeWorkspace · mergeTrupp
   *  — nothing was dropped), but two devices writing one SCBA crew's record at once gets a
   *  Verlauf note so a human checks. Buffers like the attendance channel until registration. */
  onTruppConflicts?: (conflicts: RecordConflict[]) => void
  private truppConflictBuf: RecordConflict[] = []
  /** the lifecycle state on its own, before the cache-durability overlay (effectiveSyncStatus) */
  private base: SyncStatus
  /** what the UI last saw — the overlaid value */
  private status: SyncStatus
  /** did the most recent offline-cache write actually land? Per-incident on purpose: the global
   *  isStorageDegraded() flag also moves for unrelated keys (config, roster), which would make
   *  this incident's badge flap. */
  private cacheDurable = true
  /** The main cache slot holds ANOTHER session's unsynced dirty work that init() could NOT copy
   *  to a durable parking slot (a full store). That copy is the only one, so this session must
   *  never overwrite the slot — writeCache/flushCache no-op here and report the cache as
   *  non-durable instead. Cleared only by a reload (a fresh init re-attempts the park once the
   *  storage pressure has cleared). See init / serveServerWithoutCaching. */
  private mainSlotBlocked = false

  constructor(
    private readonly incidentId: string,
    private readonly opts: WorkspaceSyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000
    // The cache lives in IndexedDB (async), so it can't be read in the constructor; init()
    // loads it before the first edit. Start empty/synced until then.
    // …stamped with the session that opened this incident, so a teardown write that lands AFTER
    // that session ended (a denial unmounts the app) still says whose work it is.
    this.entry = { workspace: {}, baseRev: 0, dirty: false, lastSyncedAt: null, owner: cacheOwner ?? undefined }
    this.base = 'synced'
    this.status = 'synced'
  }

  /** Record the lifecycle state, then publish whatever the overlay makes of it. */
  private setStatus(s: SyncStatus) {
    this.base = s
    this.publish()
  }

  /** Fire onStatus only on a real transition (de-dupes repeated saves while pending). */
  private publish() {
    const eff = effectiveSyncStatus(this.base, this.entry.dirty, this.cacheDurable)
    if (this.status === eff) return
    this.status = eff
    this.onStatus?.(eff)
  }

  /** Cache one revision for reload/offline, KEEPING whether it was durable. A refused write means
   *  any unsynced edit in it exists only in this tab, which `publish` turns into 'storage'.
   *  A full device evicts map tiles and retries first — the incident record outranks scenery.
   *
   *  Trailing-debounced (CACHE_DEBOUNCE_MS): several surfaces save per keystroke, and each write
   *  is a structured clone + IDB put of the WHOLE blob — on a full device also a tile eviction
   *  per key, which destroyed the prefetched map area while a Bemerkung was being typed. Only the
   *  latest entry matters, so a burst lands once. Every path that must not lose the write flushes
   *  synchronously first: teardown (flushKeepalive / dispose) and the server push (the ancestor
   *  the cache carries has to be the one we pushed). */
  private writeCache() {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = setTimeout(() => this.flushCache(), CACHE_DEBOUNCE_MS)
  }

  /** Write the current entry to the offline cache NOW (a no-op when nothing is waiting). */
  private flushCache() {
    if (!this.cacheTimer) return
    clearTimeout(this.cacheTimer)
    this.cacheTimer = null
    // The main slot is holding another session's un-parked unsynced work (see
    // serveServerWithoutCaching). Writing our state over it would destroy the only copy, so this
    // session stays in memory only and reports the cache as non-durable — nothing is written here.
    if (this.mainSlotBlocked) {
      if (!this.disposed && this.cacheDurable) { this.cacheDurable = false; this.publish() }
      return
    }
    // The entry already carries the owner captured when it was BUILT or last edited (construction
    // / init / save / adopt). We write it VERBATIM — re-stamping the live `cacheOwner` here would
    // relabel a debounced or teardown write that lands after the identity changed, handing one
    // user's unsynced edit another user's name (SEC-10 owner races).
    void withTileEviction(() => idbSet(cacheKey(this.incidentId), this.entry)).then((ok) => {
      if (this.disposed || this.cacheDurable === ok) return
      this.cacheDurable = ok
      this.publish()
    })
  }

  /** mergeWorkspace with divergence reporting (attendance keys + concurrently edited Trupps):
   *  collected conflicts go to the registered listeners, or buffer until one registers (init
   *  runs before the view mounts). */
  private mergeReporting(base: Workspace, mine: Workspace, theirs: Workspace): Workspace {
    const conflicts: RecordConflict[] = []
    const truppConflicts: RecordConflict[] = []
    const merged = mergeWorkspace(base, mine, theirs, (c) => conflicts.push(c), (c) => truppConflicts.push(c))
    if (conflicts.length) {
      if (this.onAttendanceConflicts) this.onAttendanceConflicts(conflicts)
      else this.conflictBuf.push(...conflicts)
    }
    if (truppConflicts.length) {
      if (this.onTruppConflicts) this.onTruppConflicts(truppConflicts)
      else this.truppConflictBuf.push(...truppConflicts)
    }
    return merged
  }

  /** Conflicts reported before a listener registered (init()'s cold-reopen merge) — the
   *  live view drains them once on mount, then follows via onAttendanceConflicts. */
  drainAttendanceConflicts(): RecordConflict[] {
    const buf = this.conflictBuf
    this.conflictBuf = []
    return buf
  }

  /** Same drain for the Trupp channel (see onTruppConflicts). */
  drainTruppConflicts(): RecordConflict[] {
    const buf = this.truppConflictBuf
    this.truppConflictBuf = []
    return buf
  }

  /**
   * The whole owner model, in one place. Decide what the current session may load from the main
   * cache slot, and protect what it may not — so a DIFFERENT user can never inherit or destroy
   * another user's cached or unsynced work:
   *   · owned by me → mine, serve it (the fast, common path).
   *   · ownerless + clean → a pre-ownership snapshot (the server already has it). Adopt it to me,
   *     so the NEXT, different user can't read it, then serve it.
   *   · ownerless + dirty → unattributable unsynced work (written before owners existed). Park it
   *     under the orphan key, never serve it: I can't prove I'm its author. The park is what makes
   *     an ONLINE upgrade safe — without it, init()'s server fetch overwrites the only copy.
   *   · owned by someone else + dirty → their unsynced work. PARK it under their own key so I can
   *     reuse the main slot without destroying it (the SEC-10 regression: a plain reload used to
   *     clobber it), and they recover it on their next sign-in.
   *   · owned by someone else + clean → the server has it; leave it (the next write overwrites it).
   * The rule for the two dirty cases is one rule: an UNSERVED dirty entry must be preserved BEFORE
   * init() reuses its slot for a server fetch, whether it is foreign-owned or ownerless.
   * Then, whatever the main slot held, look for MY OWN parked work — a different user (or a
   * denial) may have taken the slot after I left — and re-home it. A denial closes all of this.
   *
   * `parkBlocked` is the durable-or-abort signal: a dirty entry we may not serve was found in the
   * main slot but could NOT be copied to a durable parking slot (a full store). Its slot must then
   * be left exactly as it is — it is the only copy — so init() must not overwrite it with the
   * server snapshot, and we skip the re-home below too (that also writes the main slot).
   */
  private async loadReadableEntry(stored: CacheEntry | null): Promise<{ entry: CacheEntry | null; parkBlocked: boolean }> {
    if (stored && mayRead(stored)) return { entry: stored, parkBlocked: false }
    if (stored && !cacheDenied) {
      if (!stored.owner && !stored.dirty && cacheOwner) {
        const adopted: CacheEntry = { ...stored, owner: cacheOwner }
        await idbSet(cacheKey(this.incidentId), adopted)
        return { entry: adopted, parkBlocked: false }
      }
      // An unserved DIRTY entry is about to have its slot reused by init()'s server fetch. Copy it
      // somewhere safe FIRST — the main slot is left as-is and only a real server answer overwrites
      // it, by which point the copy exists. DURABLE-OR-ABORT: if that copy is not durable (a full
      // store — which can still permit the smaller clean-snapshot write that would then destroy the
      // only copy), leave the slot untouched and abort the reuse (parkBlocked). Foreign-owned goes
      // to its owner's key; ownerless (pre-upgrade) goes to the orphan key. `stored.owner` here is
      // necessarily a DIFFERENT user — an entry owned by me would have been served by mayRead above.
      if (stored.dirty) {
        const durable = stored.owner
          ? await idbSet(ownerCacheKey(this.incidentId, stored.owner), stored)
          : await this.parkOrphan(stored)
        if (!durable) return { entry: null, parkBlocked: true }
      }
    }
    if (cacheOwner && !cacheDenied) {
      const parked = await idbGet<CacheEntry>(ownerCacheKey(this.incidentId, cacheOwner))
      if (parked && parked.owner === cacheOwner) {
        // The slot is mine again: re-home my work, then clear the bucket — but ONLY once the main
        // write is CONFIRMED durable. Deleting the parked copy after a failed write (a full store)
        // would be the exact data loss the parking exists to prevent, so on failure the sole copy
        // stays under the owner key for the next attempt.
        const wrote = await idbSet(cacheKey(this.incidentId), parked)
        if (wrote) await idbDel(ownerCacheKey(this.incidentId, cacheOwner))
        return { entry: parked, parkBlocked: false }
      }
    }
    return { entry: null, parkBlocked: false }
  }

  /** Preserve unattributable pre-ownership unsynced work before its slot is reused. First writer
   *  wins: an orphan already parked is the real pre-upgrade copy, so it is never overwritten by a
   *  later (necessarily post-upgrade, hence owner-stamped) main-slot state — and, being already
   *  parked, it is itself a durable copy. Returns whether a durable copy now exists at the orphan
   *  key (an existing one, or a freshly written one), so the caller can honour durable-or-abort. */
  private async parkOrphan(stored: CacheEntry): Promise<boolean> {
    const existing = await idbGet<CacheEntry>(orphanCacheKey(this.incidentId))
    if (existing) return true
    return idbSet(orphanCacheKey(this.incidentId), stored)
  }

  /** The server answered, but the main slot holds another session's unsynced dirty work that could
   *  not be parked durably (a full store). Overwriting it would destroy the only copy, so serve the
   *  fetched workspace from MEMORY and leave the cache untouched: this session runs without a
   *  durable cache for this incident (mainSlotBlocked) until a reload re-attempts the park after the
   *  storage pressure clears. The degraded durability surfaces via cacheDurable — the honest place
   *  for it is the Offline-Bereitschaft sheet (device readiness), since the server has our latest. */
  private serveServerWithoutCaching(ws: Workspace, rev: number): { workspace: Workspace; rev: number; fromCache: false } {
    this.mainSlotBlocked = true
    this.entry = { workspace: ws, base: ws, baseRev: rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? undefined }
    this.cacheDurable = false
    this.opts.onRev?.(rev)
    this.setStatus('synced')
    return { workspace: ws, rev, fromCache: false }
  }

  /** Load initial state: prefer server; fall back to offline cache when the server could not be
   *  ASKED. A server that answered «no» gets no fallback — see mayRead / isDenial. */
  async init(): Promise<{ workspace: Workspace | null; rev: number; fromCache: boolean }> {
    // Capture who opened this incident BEFORE any await. A login/logout can land during the server
    // fetch below (auth.adoptUser moves the module-level owner), and the cached unsynced work we
    // may serve or stamp belongs to THIS session — never the one that happened to be live when the
    // fetch resolved. Everything owner-related below keys off `ownerAtStart`, not the live value.
    const ownerAtStart = cacheOwner
    // Read the offline cache once up front and seed entry/status from it, so the sync badge is
    // correct even while the server fetch is in flight (and so a cold offline reopen restores
    // unsynced edits immediately). The server fetch below refines this.
    const stored = await readCache(this.incidentId)
    // Decide what THIS session may load — and protect what it may not (see loadReadableEntry:
    // another user's unsynced work is parked, never destroyed or served to a different account).
    const { entry: cached, parkBlocked } = await this.loadReadableEntry(stored)
    if (cached) {
      this.entry = cached
      this.setStatus(cached.dirty ? 'pending' : 'synced')
    }
    try {
      const { workspace, workspace_rev } = await getWorkspace(this.incidentId)
      const ws = workspace ?? {}
      // The main slot holds an unserved dirty entry loadReadableEntry could NOT park durably. It is
      // the only copy of that work, so we must not reuse the slot: serve the server snapshot from
      // memory and leave the cache untouched (durable-or-abort — see serveServerWithoutCaching).
      if (parkBlocked) return this.serveServerWithoutCaching(ws, workspace_rev)
      // TOCTOU guard: if the identity switched during the fetch, the cached dirty work is the
      // PREVIOUS session's. Serving or re-stamping it under the new identity would leak/mislabel
      // it, so park it for its real owner (same rule as loadReadableEntry) and give the new
      // identity the clean server snapshot instead.
      const identityHeld = cacheOwner === ownerAtStart
      if (cached?.dirty && identityHeld) {
        // Unsynced local edits sit in the offline cache. If they're at the same base the server
        // is at, keep them verbatim. If the server advanced while we were offline (a cold reopen
        // after another device pushed), three-way merge our edits against it using the cached
        // ancestor — the reopen analogue of the live 409 path — so independent edits both survive
        // instead of the local ones being silently dropped. The merge result stays dirty and a
        // later flush pushes it at the new rev.
        if (cached.baseRev === workspace_rev) {
          this.entry = cached
          this.setStatus('pending')
          return { workspace: cached.workspace, rev: workspace_rev, fromCache: true }
        }
        const server = workspace ?? {}
        const merged = this.mergeReporting(cached.base ?? {}, cached.workspace, server)
        this.entry = { workspace: merged, base: server, baseRev: workspace_rev, dirty: true, lastSyncedAt: cached.lastSyncedAt, owner: ownerAtStart ?? cached.owner }
        this.writeCache()
        this.opts.onRev?.(workspace_rev)
        this.setStatus('pending')
        return { workspace: merged, rev: workspace_rev, fromCache: true }
      }
      if (cached?.dirty && !identityHeld) {
        // Same durable-or-abort rule as loadReadableEntry: the previous session's work is the only
        // copy until this park lands, so a failed park must not let the slot be overwritten below.
        const owner = cached.owner ?? ownerAtStart
        const durable = owner
          ? await idbSet(ownerCacheKey(this.incidentId, owner), { ...cached, owner })
          : await this.parkOrphan(cached)
        if (!durable) return this.serveServerWithoutCaching(ws, workspace_rev)
      }
      this.entry = { workspace: ws, base: ws, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? undefined }
      this.writeCache()
      this.opts.onRev?.(workspace_rev)
      this.setStatus('synced')
      return { workspace, rev: workspace_rev, fromCache: false }
    } catch (e) {
      // ⚠️ The offline fallback answers SILENCE, never a refusal (SEC-10). A 401 says this
      // browser has no session left, so the device may not answer from its own copy either —
      // and a 401 is device-wide, so every other open incident is locked with it. A 403 is
      // narrower (this session, this incident: an Einsatz-Link outside its Einsatz), so it
      // closes this read alone. Everything else — 5xx, a 404, a merge that threw — keeps the
      // old fallback: nothing about it says the operator lost their right to their own work.
      if (isDenial(e)) {
        if (e instanceof ApiError && e.status === 401) denyWorkspaceCache()
        throw e
      }
      if (cached) {
        this.entry = cached
        this.setStatus(cached.dirty ? 'pending' : 'synced')
        return { workspace: cached.workspace, rev: cached.baseRev, fromCache: true }
      }
      throw e
    }
  }

  /** Queue a save. Writes the offline cache immediately; flushes to server debounced. */
  save(workspace: Workspace) {
    if (this.disposed) return
    this.saveSeq++
    // Stamp the editing session NOW (the enqueue moment), so the debounced write can't be
    // relabelled if the identity changes before it lands (SEC-10 owner races). An entry that
    // already knows its owner keeps it — recovered/parked work stays its author's.
    this.entry = { ...this.entry, workspace, dirty: true, owner: this.entry.owner ?? cacheOwner ?? undefined }
    this.writeCache()
    this.setStatus('pending')
    this.armDebounce()
  }

  private armDebounce() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
  }

  /** Force a synchronous-ish flush (tab hide / beforeunload / reconnect / incident switch). */
  async flush(): Promise<void> {
    if (this.flushing || !this.entry.dirty || this.disposed) return
    this.flushing = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      this.flushCache() // the cache must carry what is about to become the ancestor
      await this.pushCurrent()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await this.resolveConflict()
      } else if (e instanceof ApiError && e.status === 401) {
        // The server REVOKED this session mid-flush. A 401 is device-wide, exactly as in init():
        // lock every cached read at once (denyWorkspaceCache), so a tab left open past revocation
        // stops serving on its next flush/poll instead of only when it happens to re-init. NOT a
        // 403 — that can be the Atemschutz-Link slice legitimately refused the full PUT, which is
        // not revocation. Stay dirty: the work is kept for the same user's next sign-in, never lost.
        denyWorkspaceCache()
        this.setStatus('error')
      } else if (e instanceof ApiError && e.status === 0) {
        this.setStatus('offline') // stay dirty; the `online` event or the backoff retries
      } else {
        this.setStatus('error') // server/other error (incl. 403); stay dirty, retried by the backoff
      }
    } finally {
      this.flushing = false
      // Still dirty with no flush queued (offline / server error / exhausted merge retries)
      // → arm the automatic backoff so an idle device recovers without a manual sync.
      if (this.entry.dirty && !this.timer) this.scheduleRetry()
    }
  }

  /** Exponential-backoff re-flush: 5s · 10s · 20s · 40s · then every 60s while dirty. */
  private scheduleRetry() {
    if (this.disposed) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = Math.min(60_000, 5_000 * 2 ** this.retryCount)
    this.retryCount++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, delay)
  }

  /**
   * Last-ditch flush for page teardown (tab hidden / pagehide). The async flush() above
   * issues a normal fetch that the browser aborts the instant the document unloads — on iOS
   * PWAs (backgrounded / locked / swiped away) that's the usual path, so edits made inside
   * the debounce window reach only this device's cache and are lost on any other device.
   * This fires a `keepalive` PUT the browser completes after teardown. Fire-and-forget: we
   * can't await or merge the response while the page is dying, so dirty/baseRev stay as-is —
   * a same-device reopen still reconciles from the cache, and once the server accepts this
   * push every device's next load (or live-poll) pulls the up-to-date revision. If the push
   * raced a concurrent server edit (409) it's simply dropped server-side; the next real
   * flush() resolves it via the normal three-way merge. No-op when clean. */
  flushKeepalive(): void {
    this.flushCache() // the page is dying — the debounce would never fire
    if (!this.entry.dirty || this.disposed) return
    if (this.opts.slice === 'trupps') putWorkspaceTruppsBeacon(this.incidentId, truppSlice(this.entry.workspace), this.entry.baseRev)
    else putWorkspaceBeacon(this.incidentId, this.entry.workspace, this.entry.baseRev)
  }

  /** The ONE write. `slice: 'trupps'` sends the Atemschutz slice on its own route; everything
   *  else about a push — when, at which base_rev, and what a 409 means — is identical, which is
   *  why the merge/retry machinery below never has to know which session it is running in. */
  private push(workspace: Workspace, baseRev: number) {
    return this.opts.slice === 'trupps'
      ? putWorkspaceTrupps(this.incidentId, truppSlice(workspace), baseRev)
      : putWorkspace(this.incidentId, workspace, baseRev)
  }

  // Push the current workspace at the current baseRev. On success, advance baseRev and
  // clear dirty — UNLESS a newer save() landed during the in-flight PUT (detected via
  // saveSeq), in which case the newest content stays dirty and we re-arm a flush so it
  // isn't silently marked synced-but-never-sent. Throws on 409/other for the caller.
  private async pushCurrent(): Promise<void> {
    const seqAtStart = this.saveSeq
    const pushed = this.entry.workspace
    const { workspace_rev } = await this.push(pushed, this.entry.baseRev)
    this.retryCount = 0 // server accepted a push → backoff starts over on the next failure
    if (this.saveSeq === seqAtStart) {
      // server now holds exactly what we pushed → that becomes the new merge ancestor.
      this.entry = { ...this.entry, base: pushed, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
      this.setStatus('synced')
    } else {
      // a newer edit arrived mid-flush — keep it dirty (rebased) and schedule another flush.
      // The ancestor is still what we just pushed (the part the server has).
      this.entry = { ...this.entry, base: pushed, baseRev: workspace_rev, lastSyncedAt: Date.now() }
      this.setStatus('pending')
      this.armDebounce()
    }
    this.writeCache()
    this.opts.onRev?.(workspace_rev)
  }

  // The server moved ahead of us (409). Instead of one whole snapshot winning, three-way
  // merge our edits and the server's against their common ancestor (entry.base) and push the
  // union: independent edits both survive, same-object edits are last-writer-wins, deletes
  // beat concurrent edits. We're inside an in-flight flush(), so push DIRECTLY (calling
  // flush() would see flushing===true and no-op). Retry on a fresh 409 by re-merging.
  //
  // The fetch and the merge sit INSIDE the try on purpose: a GET that dies offline mid-merge,
  // or a merge that throws on a server blob this app did not write, used to escape flush()'s
  // own catch as an unhandled rejection — no status, no toast, and the backoff re-threw it every
  // 5–60 s. Now either lands in 'offline' / 'error' like a failed push, so the sync toast and
  // «Jetzt synchronisieren» appear and the edits stay dirty in the cache.
  private async resolveConflict() {
    // The content that 409'd — the common ancestor for any local edit that lands while the
    // merge PUT is in flight (so that newer edit can be re-based onto the merge, not lost).
    const mine0 = this.entry.workspace
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const server = await getWorkspace(this.incidentId)
        const merged = this.mergeReporting(this.entry.base ?? {}, this.entry.workspace, server.workspace ?? {})
        this.entry = { ...this.entry, workspace: merged, base: server.workspace ?? {}, baseRev: server.workspace_rev, dirty: true }
        this.writeCache()
        const seqAtStart = this.saveSeq
        const { workspace_rev } = await this.push(merged, server.workspace_rev)
        this.opts.onRev?.(workspace_rev)
        this.retryCount = 0 // merge landed → backoff starts over on the next failure
        if (this.saveSeq === seqAtStart) {
          this.entry = { ...this.entry, base: merged, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
          this.writeCache()
          this.setStatus('synced')
          // Surface the merged union to the live view in place, so the resolver sees the other
          // device's additions without a remount.
          if (this.onApplyMerged) this.onApplyMerged(merged, workspace_rev)
          else this.opts.onServerWorkspace?.(merged, workspace_rev)
        } else {
          // A local edit landed during the merge PUT. It was built on `mine0` (pre-merge), so
          // re-base it onto the merged result — otherwise pushing it blindly next flush would
          // overwrite the remote additions we just merged in. Different objects all survive.
          const remerged = mergeWorkspace(mine0, this.entry.workspace, merged)
          this.entry = { ...this.entry, workspace: remerged, base: merged, baseRev: workspace_rev, dirty: true, lastSyncedAt: Date.now() }
          this.writeCache()
          this.setStatus('pending')
          this.armDebounce()
        }
        this.opts.onMerged?.()
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) continue // someone else landed too — re-merge
        if (e instanceof ApiError && e.status === 401) denyWorkspaceCache() // revoked mid-merge — deny device-wide, like flush()
        this.setStatus(e instanceof ApiError && e.status === 0 ? 'offline' : 'error')
        return // offline/other: stay dirty + merged; a later flush retries
      }
    }
    // retries exhausted — leave it dirty for a later flush to pick up
    this.setStatus('error')
  }

  /**
   * Adopt a server revision the app fetched out-of-band (the live-follow poll), rebasing
   * our cache onto it so the NEXT local edit pushes at the right base_rev instead of 409ing.
   * Drops any local dirty state, so callers must only adopt when not dirty — the live-follow
   * poll gates on `!hasUnsynced` for exactly this reason. Keeping every (non-editing) device
   * rebased on the latest rev also means genuine conflicts only arise on truly simultaneous
   * edits, not on a stale base.
   */
  adoptServer(workspace: Workspace, rev: number) {
    if (this.disposed) return
    this.entry = { workspace, base: workspace, baseRev: rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? this.entry.owner }
    this.writeCache()
    this.opts.onRev?.(rev)
    this.setStatus('synced')
  }

  get rev(): number {
    return this.entry.baseRev
  }
  get hasUnsynced(): boolean {
    return this.entry.dirty
  }
  get syncStatus(): SyncStatus {
    return this.status
  }
  /** epoch ms of the last successful server sync, or null if never synced this session. */
  get lastSyncedAt(): number | null {
    return this.entry.lastSyncedAt
  }

  dispose() {
    this.flushCache() // land the last edit before the debounce is torn down with the instance
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }
}
