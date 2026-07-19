import { ApiError, apiBeacon, apiGet, apiPost } from './api'
import { idbGet, idbSet } from './idb'
import type { TimelineEvent } from '../types'

/**
 * Journal (Verlauf) client store — the row-based replacement for the in-blob timeline.
 *
 * Rows are append-only records on the server (see backend/app/api/journal.py); this store
 * keeps the incident's local copy: fetched server rows (with their seq cursor), an offline
 * OUTBOX of rows not yet accepted (IDB-persisted, retried on poll/online + a keepalive
 * beacon at page teardown — the mediaQueue pattern), and a session-only overlay for blob:
 * URLs that must never be persisted.
 *
 * Invariants that matter (each guards a reviewed data-loss window):
 * - `latestSeq` (the pull cursor) is advanced ONLY by pull(), never by a flush response —
 *   a flush that jumped the cursor would skip rows other devices appended in between, and
 *   a lost-response retry (idempotent skip, empty accepted list) would skip our own.
 * - Legacy blob rows are echoed into every save FOREVER (bounded: the frozen pre-migration
 *   set). Shipping an empty timeline instead would merge as deletions and wipe the Verlauf
 *   on old-app devices mid-incident. New incidents start with no legacy → empty echo.
 * - A row the server REJECTS (4xx validation) must not wedge the outbox: flush drops to
 *   single-row mode to isolate it, dead-letters the poisoned row (kept visible locally),
 *   and keeps the rest flowing.
 * - persist() is skipped while read-only, so a demoted/viewer tab can never clobber the
 *   editing tab's persisted outbox under the shared IDB key.
 */

interface ServerRow { seq: number; row: TimelineEvent }
interface JournalPage { entries: ServerRow[]; latest_seq: number }
interface Persisted { rows: ServerRow[]; latestSeq: number; outbox: TimelineEvent[]; dead?: TimelineEvent[] }

const KEY = (incidentId: string) => `kp-journal-${incidentId}`
const FLUSH_BATCH = 400

/** blob: object URLs are session-local — never persist them (display via the overlay). */
function stripSessionUrls(row: TimelineEvent): TimelineEvent {
  const { audioUrl, photoUrl, ...rest } = row
  return {
    ...rest,
    ...(audioUrl && !audioUrl.startsWith('blob:') ? { audioUrl } : {}),
    ...(photoUrl && !photoUrl.startsWith('blob:') ? { photoUrl } : {}),
  }
}

const isValidationError = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 400 || e.status === 413 || e.status === 422)

export class JournalStore {
  private state: Persisted = { rows: [], latestSeq: 0, outbox: [], dead: [] }
  /** legacy blob rows in CHRONOLOGICAL (oldest-first) order — the blob stores newest-first */
  private legacy: TimelineEvent[] = []
  /** stable echo for buildPayload — recreated ONLY when the legacy set changes, so the
   *  workspace save memo doesn't re-fire (and re-PUT the whole blob) on every journal row */
  private blobEcho: TimelineEvent[] = []
  private overlay = new Map<string, Partial<TimelineEvent>>()
  private flushing = false
  private disposed = false
  private initDone = false
  /** after a 4xx: send rows one at a time to isolate the poisoned one */
  private singleMode = false
  private patchSeq = 0
  private readOnly: boolean
  onChange?: () => void

  constructor(private readonly incidentId: string, readOnly: boolean) {
    this.readOnly = readOnly
  }

  /** read-only can flip at runtime (viewer role is fixed, but the tab lock isn't) */
  setReadOnly(v: boolean) {
    const was = this.readOnly
    this.readOnly = v
    if (was && !v) {
      this.persist() // we own the IDB key again — write our state before anything else
      void this.flush()
    }
  }

  async init(legacyNewestFirst: TimelineEvent[]): Promise<void> {
    const cached = await idbGet<Persisted>(KEY(this.incidentId))
    if (cached && !this.disposed) {
      // MERGE the snapshot into current state — rows may have been appended while the
      // idbGet was in flight, and replacing the state would silently drop them.
      const rowIds = new Set(this.state.rows.map((r) => r.row.id))
      for (const r of cached.rows) if (!rowIds.has(r.row.id)) this.state.rows.push(r)
      this.state.rows.sort((a, b) => a.seq - b.seq)
      const outIds = new Set(this.state.outbox.map((r) => r.id))
      this.state.outbox = [...cached.outbox.filter((r) => !outIds.has(r.id)), ...this.state.outbox]
      this.state.dead = [...(cached.dead ?? []), ...(this.state.dead ?? [])]
      this.state.latestSeq = Math.max(this.state.latestSeq, cached.latestSeq)
    }
    this.initDone = true
    this.ingestLegacy(legacyNewestFirst)
    await this.pull()
    await this.flush()
  }

  /** Blob-timeline rows arriving at open or via any live-poll/merge inflow. */
  ingestLegacy(newestFirst: TimelineEvent[]) {
    if (this.disposed) return
    const next = [...newestFirst].reverse()
    const changed =
      next.length !== this.legacy.length || next.some((r, i) => r.id !== this.legacy[i]?.id)
    this.legacy = next
    if (changed) this.blobEcho = [...this.legacy].reverse()
    if (!this.readOnly && this.legacy.length) {
      const known = this.knownIds()
      const fresh = this.legacy.filter((r) => !known.has(r.id)).map(stripSessionUrls)
      if (fresh.length) {
        this.state.outbox.push(...fresh) // chronological → server seqs preserve the order
        this.persist()
        void this.flush()
      }
    }
    this.emit()
  }

  /** Append a new row (the single write path — every log/logPlan/composer row lands here). */
  append(row: TimelineEvent) {
    if (this.disposed) return
    if (row.audioUrl?.startsWith('blob:')) this.overlaySession(row.id, { audioUrl: row.audioUrl })
    if (row.photoUrl?.startsWith('blob:')) this.overlaySession(row.id, { photoUrl: row.photoUrl })
    this.state.outbox.push(stripSessionUrls(row))
    this.persist()
    this.emit()
    if (this.initDone) void this.flush()
  }

  /** Later-arriving enrichment (transcript, uploaded media URL) — a NEW row, never an edit.
   *  Clearing a field sends '' (never undefined: JSON.stringify drops undefined keys, and
   *  the clear would un-apply once the outbox copy is replaced by the server row). */
  appendPatch(targetId: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'audioUrl' | 'photoUrl' | 'textEdit' | 'retracted'>>) {
    const at = new Date().toISOString()
    const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v ?? '']))
    // seq suffix: two patches for one target can land in the same millisecond
    this.append({ id: `tp${Date.now()}-${this.patchSeq++}-${targetId}`, t: '', at, icon: '', text: '', patchOf: targetId, ...clean })
  }

  /** Session-only display fields (blob: URLs from a fresh capture / the media-queue restore). */
  overlaySession(id: string, fields: Partial<TimelineEvent>) {
    this.overlay.set(id, { ...this.overlay.get(id), ...fields })
    this.emit()
  }

  async flush(): Promise<void> {
    if (this.flushing || this.readOnly || this.disposed || !this.state.outbox.length) return
    this.flushing = true
    let accepted = false
    try {
      const batch = this.state.outbox.slice(0, this.singleMode ? 1 : FLUSH_BATCH)
      const res = await apiPost<JournalPage>(`/api/incidents/${this.incidentId}/journal`, { entries: batch })
      if (this.disposed) return
      // the server accepted (or idempotently already held) every row in the batch
      const sent = new Set(batch.map((r) => r.id))
      this.state.outbox = this.state.outbox.filter((r) => !sent.has(r.id))
      this.adoptRows(res.entries) // display only — the pull cursor NEVER advances here
      if (!this.state.outbox.length) this.singleMode = false
      this.persist()
      this.emit()
      accepted = true
    } catch (e) {
      if (isValidationError(e)) {
        if (this.singleMode || this.state.outbox.length === 1) {
          // the poisoned row itself — dead-letter it so the rest of the journal keeps flowing
          // (kept locally + in IDB for diagnosis; the row stays visible on this device)
          const [bad, ...rest] = this.state.outbox
          this.state.dead = [...(this.state.dead ?? []), bad]
          this.state.outbox = rest
          console.error('Journalzeile vom Server abgelehnt — lokal zurückgestellt:', bad?.id, e)
          this.persist()
          this.emit()
        } else {
          this.singleMode = true // isolate the poisoned row one-by-one on the next flushes
        }
      }
      /* transient (offline / 5xx) — outbox stays, retried on the next poll tick or 'online' */
    } finally {
      this.flushing = false
    }
    if (accepted && !this.disposed) {
      if (this.state.outbox.length) {
        void this.flush() // drain the rest ONLY after a successful batch (no failure spin)
      } else {
        void this.pull() // converge: pick up our accepted seqs + anything appended meanwhile
      }
    }
  }

  /** Last-ditch teardown push (pagehide / app swiped away): the outbox rides a keepalive
   *  beacon the browser completes after the page is gone. Idempotent server → a double
   *  send with the next regular flush is harmless. */
  flushKeepalive(): void {
    if (this.readOnly || this.disposed || !this.state.outbox.length) return
    apiBeacon(`/api/incidents/${this.incidentId}/journal`, { entries: this.state.outbox.slice(0, FLUSH_BATCH) })
  }

  /** Fetch rows newer than our cursor (the live-poll tick; an empty page is a few bytes).
   *  The ONLY place the cursor advances — seqs below it are guaranteed fetched. */
  /** Returns true when new rows were adopted — the live-poll loop uses this to stay on its fast
   *  cadence while rows are arriving and ease off once the incident goes quiet (see pollBackoff). */
  async pull(): Promise<boolean> {
    if (this.disposed) return false
    try {
      const res = await apiGet<JournalPage>(
        `/api/incidents/${this.incidentId}/journal?since_seq=${this.state.latestSeq}`,
      )
      if (this.disposed || !res.entries.length) return false
      this.adoptRows(res.entries)
      this.state.latestSeq = Math.max(this.state.latestSeq, res.latest_seq)
      // another device may have pushed rows we still hold in the outbox (migration overlap)
      const server = new Set(this.state.rows.map((r) => r.row.id))
      this.state.outbox = this.state.outbox.filter((r) => !server.has(r.id))
      this.persist()
      this.emit()
      return true
    } catch {
      /* offline — the cached copy stands */
      return false
    }
  }

  /** What buildPayload embeds in the blob: the FROZEN legacy echo (bounded — pre-migration
   *  rows only, so old-app devices in a mixed-version incident never see a merge-deletion
   *  of their Verlauf). New rows never enter the blob; new incidents echo nothing. Stable
   *  identity so the workspace save memo doesn't re-fire per journal row. */
  blobTimeline(): TimelineEvent[] {
    return this.blobEcho
  }

  /** rows waiting for the server (report preflight / sync hints) */
  get pendingCount(): number {
    return this.state.outbox.length
  }

  /** The UI's timeline: union (server ∪ legacy-not-yet-on-server ∪ outbox ∪ dead-lettered),
   *  patches folded, session overlays applied, newest-first (what the old in-blob state
   *  looked like). */
  display(): TimelineEvent[] {
    const out: TimelineEvent[] = []
    const seen = new Set<string>()
    const push = (r: TimelineEvent) => {
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r) }
    }
    for (const r of this.state.rows) push(r.row)
    for (const r of this.legacy) push(r)
    for (const r of this.state.outbox) push(r)
    for (const r of this.state.dead ?? []) push(r)
    // fold enrichment patches onto their targets, hide the patch rows
    const patched = new Map(out.filter((r) => !r.patchOf).map((r) => [r.id, r]))
    for (const p of out) {
      if (!p.patchOf) continue
      const target = patched.get(p.patchOf)
      if (!target) continue
      const { id: _i, t: _t, at: _a, icon: _ic, text: _tx, patchOf: _p, textEdit, ...fields } = p
      patched.set(target.id, {
        ...patched.get(p.patchOf)!,
        ...fields,
        // a text correction rides in `textEdit` (patch rows carry a filler text: '')
        ...(textEdit ? { text: textEdit } : {}),
      })
    }
    // retracted rows fold out of display entirely (the record keeps original + retraction)
    const rows = out.filter((r) => !r.patchOf).map((r) => patched.get(r.id)!).filter((r) => !r.retracted)
    // session overlay last (blob: URLs beat everything for display)
    const withOverlay = rows.map((r) => (this.overlay.has(r.id) ? { ...r, ...this.overlay.get(r.id) } : r))
    return withOverlay.reverse()
  }

  dispose() {
    this.disposed = true
  }

  /** merge fetched/accepted rows into the local set — display state, no cursor movement */
  private adoptRows(entries: ServerRow[]) {
    const have = new Set(this.state.rows.map((r) => r.row.id))
    for (const e of entries) {
      if (!have.has(e.row.id)) { have.add(e.row.id); this.state.rows.push(e) }
    }
    this.state.rows.sort((a, b) => a.seq - b.seq)
  }

  private knownIds(): Set<string> {
    const s = new Set(this.state.rows.map((r) => r.row.id))
    for (const r of this.state.outbox) s.add(r.id)
    for (const r of this.state.dead ?? []) s.add(r.id)
    return s
  }

  private persist() {
    // a read-only store (viewer, or an editor tab demoted by the tab lock) must never
    // write the shared per-incident IDB key — it would clobber the editing tab's outbox
    if (this.readOnly) return
    void idbSet(KEY(this.incidentId), this.state)
  }

  private emit() {
    this.onChange?.()
  }
}
