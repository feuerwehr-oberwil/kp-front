// Per-incident sync engine: offline cache (IndexedDB) + debounced last-write-wins save with a
// three-way merge on conflict. Split out of the incidents data layer because it's the single
// heaviest, most stateful unit — see ./workspace for the plain get/put the engine drives.
import { ApiError } from '../api'
import { idbGet, idbSet } from '../idb'
import { mergeWorkspace, type RecordConflict } from '../mergeWorkspace'
import { getWorkspace, putWorkspace, putWorkspaceBeacon, type Workspace } from './workspace'

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
}
const cacheKey = (id: string) => `kp-front-ws-${id}`

function readCache(id: string): Promise<CacheEntry | null> {
  return idbGet<CacheEntry>(cacheKey(id))
}
// Fire-and-forget: the in-memory `entry` is the authoritative session state; this just keeps a
// durable copy for reload/offline. A storage failure is non-fatal (the server is authoritative),
// exactly like the old localStorage write that swallowed quota errors.
function writeCache(id: string, e: CacheEntry) {
  void idbSet(cacheKey(id), e)
}

/** Lifecycle of the per-incident sync, surfaced to the UI so unsynced/offline/error
 *  states are never silent: `synced` = server has our latest; `pending` = local edits
 *  not yet flushed; `offline` = a flush failed on the network (cached locally, will
 *  retry); `error` = a flush failed for another reason (also cached, also retried). */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error'

export interface WorkspaceSyncOptions {
  /** called whenever the synced revision changes (e.g. to update UI badges). */
  onRev?: (rev: number) => void
  /** called with the authoritative workspace when it must replace local state out-of-band
   *  (fallback when no in-place applier is registered — triggers a full remount). */
  onServerWorkspace?: (ws: Workspace, rev: number) => void
  /** called after a 409 was auto-merged, so the app can show a non-blocking notice. */
  onMerged?: () => void
  debounceMs?: number
}

/**
 * Per-incident sync engine. The App calls `save(workspace)` on every edit (replacing the
 * old direct localStorage write); we cache instantly, mark dirty, and flush to the server
 * debounced. `init()` loads from server (falling back to the offline cache).
 */
export class WorkspaceSync {
  private timer: ReturnType<typeof setTimeout> | null = null
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
  private status: SyncStatus

  constructor(
    private readonly incidentId: string,
    private readonly opts: WorkspaceSyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000
    // The cache lives in IndexedDB (async), so it can't be read in the constructor; init()
    // loads it before the first edit. Start empty/synced until then.
    this.entry = { workspace: {}, baseRev: 0, dirty: false, lastSyncedAt: null }
    this.status = 'synced'
  }

  /** Fire onStatus only on a real transition (de-dupes repeated saves while pending). */
  private setStatus(s: SyncStatus) {
    if (this.status === s) return
    this.status = s
    this.onStatus?.(s)
  }

  /** mergeWorkspace with attendance-divergence reporting: collected conflicts go to the
   *  registered listener, or buffer until one registers (init runs before the view mounts). */
  private mergeReporting(base: Workspace, mine: Workspace, theirs: Workspace): Workspace {
    const conflicts: RecordConflict[] = []
    const merged = mergeWorkspace(base, mine, theirs, (c) => conflicts.push(c))
    if (conflicts.length) {
      if (this.onAttendanceConflicts) this.onAttendanceConflicts(conflicts)
      else this.conflictBuf.push(...conflicts)
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

  /** Load initial state: prefer server; fall back to offline cache when offline. */
  async init(): Promise<{ workspace: Workspace | null; rev: number; fromCache: boolean }> {
    // Read the offline cache once up front and seed entry/status from it, so the sync badge is
    // correct even while the server fetch is in flight (and so a cold offline reopen restores
    // unsynced edits immediately). The server fetch below refines this.
    const cached = await readCache(this.incidentId)
    if (cached) {
      this.entry = cached
      this.setStatus(cached.dirty ? 'pending' : 'synced')
    }
    try {
      const { workspace, workspace_rev } = await getWorkspace(this.incidentId)
      if (cached?.dirty) {
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
        this.entry = { workspace: merged, base: server, baseRev: workspace_rev, dirty: true, lastSyncedAt: cached.lastSyncedAt }
        writeCache(this.incidentId, this.entry)
        this.opts.onRev?.(workspace_rev)
        this.setStatus('pending')
        return { workspace: merged, rev: workspace_rev, fromCache: true }
      }
      const ws = workspace ?? {}
      this.entry = { workspace: ws, base: ws, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
      writeCache(this.incidentId, this.entry)
      this.opts.onRev?.(workspace_rev)
      this.setStatus('synced')
      return { workspace, rev: workspace_rev, fromCache: false }
    } catch (e) {
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
    this.entry = { ...this.entry, workspace, dirty: true }
    writeCache(this.incidentId, this.entry)
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
      await this.pushCurrent()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await this.resolveConflict()
      } else if (e instanceof ApiError && e.status === 0) {
        this.setStatus('offline') // stay dirty; the `online` event or the backoff retries
      } else {
        this.setStatus('error') // server/other error; stay dirty, retried by the backoff
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
    if (!this.entry.dirty || this.disposed) return
    putWorkspaceBeacon(this.incidentId, this.entry.workspace, this.entry.baseRev)
  }

  // Push the current workspace at the current baseRev. On success, advance baseRev and
  // clear dirty — UNLESS a newer save() landed during the in-flight PUT (detected via
  // saveSeq), in which case the newest content stays dirty and we re-arm a flush so it
  // isn't silently marked synced-but-never-sent. Throws on 409/other for the caller.
  private async pushCurrent(): Promise<void> {
    const seqAtStart = this.saveSeq
    const pushed = this.entry.workspace
    const { workspace_rev } = await putWorkspace(this.incidentId, pushed, this.entry.baseRev)
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
    writeCache(this.incidentId, this.entry)
    this.opts.onRev?.(workspace_rev)
  }

  // The server moved ahead of us (409). Instead of one whole snapshot winning, three-way
  // merge our edits and the server's against their common ancestor (entry.base) and push the
  // union: independent edits both survive, same-object edits are last-writer-wins, deletes
  // beat concurrent edits. We're inside an in-flight flush(), so push DIRECTLY (calling
  // flush() would see flushing===true and no-op). Retry on a fresh 409 by re-merging.
  private async resolveConflict() {
    // The content that 409'd — the common ancestor for any local edit that lands while the
    // merge PUT is in flight (so that newer edit can be re-based onto the merge, not lost).
    const mine0 = this.entry.workspace
    for (let attempt = 0; attempt < 4; attempt++) {
      const server = await getWorkspace(this.incidentId)
      const merged = this.mergeReporting(this.entry.base ?? {}, this.entry.workspace, server.workspace ?? {})
      this.entry = { ...this.entry, workspace: merged, base: server.workspace ?? {}, baseRev: server.workspace_rev, dirty: true }
      writeCache(this.incidentId, this.entry)
      try {
        const seqAtStart = this.saveSeq
        const { workspace_rev } = await putWorkspace(this.incidentId, merged, server.workspace_rev)
        this.opts.onRev?.(workspace_rev)
        this.retryCount = 0 // merge landed → backoff starts over on the next failure
        if (this.saveSeq === seqAtStart) {
          this.entry = { ...this.entry, base: merged, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
          writeCache(this.incidentId, this.entry)
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
          writeCache(this.incidentId, this.entry)
          this.setStatus('pending')
          this.armDebounce()
        }
        this.opts.onMerged?.()
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) continue // someone else landed too — re-merge
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
    this.entry = { workspace, base: workspace, baseRev: rev, dirty: false, lastSyncedAt: Date.now() }
    writeCache(this.incidentId, this.entry)
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
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }
}
