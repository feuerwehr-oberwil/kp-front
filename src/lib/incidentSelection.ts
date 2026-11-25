// The active Einsatz owns the live poll, alarm and edit queue. Only the selection that
// actually opens may take that engine away from the operator or send updates to its view.
//
// ⚠️ It also owns the Einsatz's EDIT LOCK in this tab (lib/tabLock), because two tabs of one
// browser share one cache slot and only one engine may write it (hunt 24.11.2026, offline-sync
// F1: a promoted tab's first save erased the edit the closed tab had saved offline). The rules:
//   · the lock answers BEFORE the engine opens – an engine opened while another tab holds it is a
//     `follower` (api/workspaceSync · opts.lock) and writes nothing, not even its open;
//   · a grant opens a FRESH editor engine, which claims the slot's fence and only then reads the
//     slot – the previous holder's last committed draft – and the view is handed that engine;
//   · a lost lock (another tab's «Hier bearbeiten») retires the editor at once – no write, push
//     or retry after it, and the fence refuses any write it had not started yet;
//   · leaving the Einsatz releases the lock only after the engine's last cache write settled.
// The view reads `editing`/`current` through `subscribe` (App · useSyncExternalStore): a
// notify for every change of the open Einsatz's lock or engine; an open answers its caller instead.
import { archiveIncident, getIncident, type IncidentMeta } from './api/incidents'
import { clearIncidentMedia } from './mediaQueue'
import { WorkspaceSync, type WorkspaceSyncOptions } from './api/workspaceSync'
import { IncidentTabLock } from './tabLock'

type Opened = Awaited<ReturnType<WorkspaceSync['init']>>

/** One Einsatz in this tab: its lock, and the engine the view runs on. */
interface Seat {
  id: string
  lock: IncidentTabLock
  /** the lock's latest answer, before any engine follows it */
  granted: boolean | null
  /** resolves with the lock's first answer */
  answered: Promise<boolean>
  engine: WorkspaceSync | null
  /** the engine is the one the view shows (open finished) */
  installed: boolean
  options: WorkspaceSyncOptions
  /** a promotion in flight – one at a time */
  promoting: Promise<void> | null
  /** bumped on every lock answer: a promotion whose open saw the lock move starts over */
  answers: number
  /** left (switched away, closed, cancelled): nothing may open on it any more */
  released: boolean
}

export class IncidentSelection {
  generation = 0
  private seat: Seat | null = null
  private pending: { seat: Seat; loaded: Promise<Opened> } | null = null
  private listeners = new Set<() => void>()

  /** The engine the view runs on (null: no Einsatz open). */
  get current(): WorkspaceSync | null {
    return this.seat?.installed ? this.seat.engine : null
  }

  /** May this tab edit the open Einsatz? True with nothing open, so no banner flashes. */
  get editing(): boolean {
    return this.current?.editor ?? true
  }

  /** For useSyncExternalStore: fires when `current` or `editing` changed. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify() {
    for (const l of this.listeners) l()
  }

  /** «Hier bearbeiten»: move editing into this tab (the holder drops to read-only). */
  takeOver(): void {
    this.seat?.lock.takeOver()
  }

  private makeSeat(id: string, options: WorkspaceSyncOptions): Seat {
    let answer: (held: boolean) => void = () => {}
    const seat: Seat = {
      id, options, granted: null, engine: null, installed: false, promoting: null, answers: 0, released: false,
      answered: new Promise<boolean>((resolve) => { answer = resolve }),
      lock: new IncidentTabLock(`kp-front-incident-${id}`, (held) => {
        const first = seat.granted === null
        seat.granted = held
        seat.answers++
        if (first) { answer(held); return }
        // ⚠️ synchronously, inside the grant: the fresh engine requests its fence claim in this
        // call, which orders the claims by grant (api/workspaceSync · claimFence)
        if (held) void this.promote(seat)
        else {
          seat.engine?.retire()
          if (seat === this.seat) this.notify()
        }
      }),
    }
    return seat
  }

  /** The lock came (back) to this tab: open a fresh editor engine and hand it to the view. */
  private promote(seat: Seat): Promise<void> {
    if (seat.promoting || !seat.installed || seat.engine?.editor) return seat.promoting ?? Promise.resolve()
    const answers = seat.answers
    let again = false
    seat.promoting = (async () => {
      const fresh = new WorkspaceSync(seat.id, { ...seat.options, lock: 'editor' })
      try {
        await fresh.init()
      } catch {
        fresh.dispose() // stays read-only; the next grant or a reload tries again
        return
      }
      // ⚠️ The lock moved while this engine opened: another tab may have claimed and written the
      // slot after this one read it. Its read is stale and its writes would be refused – again.
      if (seat.answers !== answers) { fresh.dispose(); again = true; return }
      if (seat !== this.seat || seat.released || !seat.granted) { fresh.dispose(); return }
      const old = seat.engine
      seat.engine = fresh
      old?.dispose() // a follower or a retired editor: it writes nothing
      this.notify()
    })().finally(() => {
      seat.promoting = null
      if (again && seat === this.seat && seat.granted) void this.promote(seat)
    })
    return seat.promoting
  }

  /** Leave a seat: land the last edit, release the lock only once its write settled. */
  private release(seat: Seat | null) {
    if (!seat) return
    seat.released = true
    const engine = seat.engine
    engine?.dispose()
    void (engine?.settled() ?? Promise.resolve()).finally(() => seat.lock.stop())
  }

  private cancelPending() {
    this.release(this.pending?.seat ?? null)
    this.pending = null
  }

  /** Close the open Einsatz in this tab (no flush beyond the engine's own last cache write). */
  close() {
    const seat = this.seat
    this.seat = null
    this.release(seat)
    this.notify()
  }

  dispose() {
    this.generation++
    this.cancelPending()
    this.close()
  }

  async open(id: string, meta: IncidentMeta | undefined, options: WorkspaceSyncOptions) {
    const generation = ++this.generation
    // ⚠️ The SEAT, not its engine: a grant for the Einsatz on screen swaps its engine while this
    // switch runs, and must not cancel it (Sol r1) – the flush below asks the seat's engine then.
    const previous = this.seat
    const stillOpening = () => generation === this.generation && this.seat === previous
    if (this.pending?.seat.id !== id) this.cancelPending()
    try {
      const incident = meta ?? await getIncident(id)
      if (!stillOpening()) return null
      const shown = this.current
      if (shown?.incidentId === id) return { meta: incident, workspace: shown.workspace, rev: shown.rev }

      // A second tap on the same Einsatz joins its load. Two candidates for one id
      // would both write the same cache, including on teardown of the losing request.
      if (!this.pending) {
        // init can arm a recovery probe. Its result belongs to the engine, even while the
        // previous Einsatz is still on screen and flushing its last edit.
        const seat: Seat = this.makeSeat(id, {
          ...options,
          onServerWorkspace: (workspace, rev) => {
            if (this.current === seat.engine) options.onServerWorkspace?.(workspace, rev)
          },
          onRev: (rev) => { if (this.current === seat.engine) options.onRev?.(rev) },
          onMerged: () => { if (this.current === seat.engine) options.onMerged?.() },
        })
        seat.lock.start()
        const loaded = seat.answered.then((held) => {
          if (seat.released) throw new Error('Incident selection cancelled')
          // without Web Locks nothing orders the tabs: no fence either, as before (Sol r1)
          const lock = seat.lock.coordinated ? (held ? 'editor' : 'follower') : undefined
          seat.engine = new WorkspaceSync(id, { ...seat.options, lock })
          return seat.engine.init()
        })
        this.pending = { seat, loaded }
      }
      const candidate = this.pending
      const opened = await candidate.loaded
      if (!stillOpening()) return null
      await previous?.engine?.flush()
      if (!stillOpening()) return null
      const seat = candidate.seat
      this.release(this.seat)
      this.seat = seat
      seat.installed = true
      this.pending = null
      const engine = seat.engine as WorkspaceSync
      // the lock moved while the engine opened: catch the view up with it
      if (seat.granted && !engine.editor) void this.promote(seat)
      else if (!seat.granted && engine.editor) engine.retire()
      // ⚠️ No notify: the caller installs this Einsatz's id, meta and workspace from the answer, and
      // the view must get this engine in that same render – a notify now rendered the PREVIOUS
      // Einsatz's view over it for one commit, which drained this engine's merge notes into the
      // other Einsatz's Verlauf (Sol r1). `current`/`editing` are read in that render.
      const { workspace, rev } = engine
      // An untouched new Einsatz has a null initial blob (the engine represents it as {}).
      const stillEmpty = opened.workspace === null && rev === opened.rev && !Object.keys(workspace).length
      return { meta: incident, workspace: stillEmpty ? null : workspace, rev }
    } catch (error) {
      if (stillOpening()) throw error
      return null
    } finally {
      if (generation === this.generation) this.cancelPending()
    }
  }
}

/** Undo a one-tap Divera take. Only the acknowledged archive can discard that take's media.
 * A switch made while the toast was visible or the request was in flight keeps its live engine. */
export async function undoTakenIncident(
  active: Pick<IncidentSelection, 'current' | 'close'>, id: string, isCurrent: () => boolean,
  refreshList: () => Promise<IncidentMeta[]>,
) {
  await archiveIncident(id)
  await clearIncidentMedia(id).catch(() => {})
  const list = await refreshList()
  if (!isCurrent() || active.current?.incidentId !== id) return null
  active.close()
  return list
}
