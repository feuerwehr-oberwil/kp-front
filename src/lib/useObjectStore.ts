import { useEffect, useMemo, useRef, type SetStateAction } from 'react'
import { useUndoableDoc } from './useUndoableDoc'
import {
  anchorChanges, applyBoardToObjects, applyDocToObjects, bakeAll, bakePlan, reanchoredToKarte, sheetAnnos, viewsOf,
  type AnchorChange, type PlanFit, type TacticalObject,
} from './tacticalObjects'
import type { Doc } from './workspace'
import type { BoardDoc, Entity, LngLat } from '../types'

/**
 * THE tactical store: one collection of `TacticalObject`s, and the two legacy documents every
 * existing mutator still speaks (`Doc` for the Karte, `BoardDoc` for the plan sheets) as VIEWS
 * of it (tmp/design-unified-objects.md · phase 2).
 *
 * ⚠️ This is the change that makes the unified object real at runtime, and it is deliberately
 * shaped so that nothing above it had to change: `doc`, `board`, `setDocRaw`, `setBoard`,
 * `commit` and the gesture pair keep their exact signatures, and every call site keeps writing
 * the document it always wrote. Underneath, each write derives the view from the LIVE store,
 * hands it to the caller's updater, and folds the result back through `applyDocToObjects` /
 * `applyBoardToObjects`.
 *
 * What that buys — and why the alternatives were rejected — is that there is no second copy to
 * go stale. Two React states holding the same object (a symbol's sheet anno and its baked map
 * body) can only be kept honest by a sync effect, and a sync effect cannot tell an operator's
 * hand-placement from its own echo: it would read an undo of a Karte drag as a fresh
 * hand-placement and silently flip the object's anchor. One store, two adapters, no echo.
 *
 * ⚠️ The undo stacks snapshot OBJECTS, not the map document. That is what makes an undo
 * anchor-faithful: a drag that moved an object off its sheet is one step, and stepping back
 * restores the sheet body along with the position rather than re-deriving an anchor from a
 * position that has been put back. It also means a Karte step restores the WHOLE store — safe
 * only because the ONE global timeline (lib/undoTimeline) steps chronologically across both
 * surfaces, so everything laid down after a Karte checkpoint has already been stepped back by
 * the time that checkpoint is reached.
 */
export interface ObjectStore {
  /** the store itself — what gets persisted, and what the views are derived from */
  objects: TacticalObject[]
  /** the Karte's document, derived */
  doc: Doc
  /**
   * What every plan sheet DRAWS: the annos anchored on it, plus every geo-anchored object
   * projected onto it through its own fit (lib/planProjection). The sheet edits both with its
   * native chrome and hands the whole list back through `setBoard`, which reads each anno as the
   * gesture it was.
   *
   * ⚠️ NOT what gets persisted. `viewsOf(objects).board` is the anchor-only view the blob
   * carries: a projection is derived, and writing one into the record would give an object two
   * homes again — the very thing the unified store exists to end.
   */
  board: BoardDoc
  /** raw map write, NO history checkpoint — silent updates mid-drag.
   *
   *  ⚠️ `gesture: false` says a MACHINE produced this document, not a hand. Only a hand places
   *  an object, so a machine's changed position writes through onto the sheet anno instead of
   *  flipping the anchor to the Karte — see applyDocToObjects. The live-GPS re-route is the one
   *  caller: it rewrites an attached Leitung's coords on every poll, and read as a placement it
   *  would have torn plan-drawn hoses off their sheet with nobody touching anything.
   *
   *  ⚠️ `movedIds` narrows the same question WITHIN a hand gesture: a map write is per-document,
   *  so dragging one object also carries its docked placard and re-routes the hoses attached to
   *  it. Only the named ids were placed by the hand; the rest of that write is machine-treated. */
  setDocRaw: (update: SetStateAction<Doc>, opts?: { gesture?: boolean; movedIds?: readonly string[] }) => void
  /**
   * Plan write.
   *
   * ⚠️ OWNERSHIP DECIDES THE STACK. An edit of the sheet's OWN annos is silent here, because the
   * plan surface keeps its own per-document history (IncidentWorkspace · planHistory, Whiteboard
   * · useBoardDoc) and restores it straight back through this setter. But a sheet also draws
   * objects it does not own — the Karte's, projected onto it — and an edit of one of those is a
   * store-level act: it moves a map object, or flips its anchor, and a per-sheet snapshot of
   * annotations cannot express «this object was geo-anchored» to undo it with. So a fold that
   * touches a non-sheet-anchored object lays a checkpoint on THIS stack — the one the twin era
   * already used for exactly these edits, through the Karte's own writers.
   *
   * ⚠️ `gesture: false` says a MACHINE produced this list — the same door `setDocRaw` has, and
   * for the same reason: only a hand places an object, so a changed position crosses through the
   * fit instead of flipping an anchor (tacticalObjects · applyBoardToObjects). A plan ↶/↷
   * restoring a snapshot, the Trupp sweeps settling a chip at a hose end, a Gebäude amend or
   * storey removal: none of them is a placement. Absent ⇒ a gesture, which every surface
   * writer is. (It hard-coded `true` until 24.09.2026, so each of those could flip an anchor.)
   */
  setBoard: SetBoard
  /** A plan step is beginning (IncidentWorkspace · rememberPlanStep). One gesture is one step on
   *  either stack, so the first cross-ownership fold after this arms is the only one that
   *  checkpoints; a discrete write outside a gesture is its own step and needs no arming. */
  beginSheetStep: () => void
  /** …and it is over — called by the surface from its own `phase === 'end'` paths. ⚠️ The
   *  surface has to say so: no DOM event can. A release writes its final frame from the same
   *  pointerup a listener would hear, so anything watching the window closes the gesture one
   *  fold too early and the last sample lands as a second undo step (↶ then half-un-turns the
   *  object). See the net in the effect below for what the window is still good for. */
  endSheetStep: () => void
  /** checkpoint the store, then apply a map update — one undo step (no-op if readOnly).
   *  `gesture: false` — the step is an undo step but NOT a hand-placement: a restored snapshot
   *  («Zurück auf Stand am Einsatzort», lib/gpsReturn) writes through the fit instead of
   *  flipping a plan-drawn object's anchor (AGENTS.md · «A MACHINE write never flips an anchor»). */
  commit: (updater: (d: Doc) => Doc, opts?: { gesture?: boolean }) => void
  /** Re-anchor one plan-anchored object onto the Karte (tacticalObjects · reanchoredToKarte) —
   *  one undo step, the flip reported like a drag's. `coord` places a symbol that has no baked
   *  body yet. Returns whether anything changed. */
  reanchorToKarte: (id: string, coord?: LngLat) => boolean
  beginDrag: () => void
  endDrag: () => void
  /** a hand is mid-gesture on either surface: a Karte drag (`beginDrag`) or a plan step
   *  (`beginSheetStep`) is open. Read live — for the save path (useIncidentSync · gestureOpen). */
  gestureOpen: () => boolean
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  /** The LIVE store — advanced by every write, unlike `objects` (a per-render snapshot). For a
   *  reader that runs after a writer in the same task (the undo step's name, IncidentWorkspace). */
  current: () => TacticalObject[]
  /** hydrate wholesale from merged/remote state — drops the history with it, because the local
   *  stacks no longer describe anything that exists */
  replaceObjects: (objects: TacticalObject[]) => void
  /**
   * Re-derive every baked map body: the georeference of some plan has changed, so every symbol
   * standing on that sheet now stands somewhere else on the ground. Returns HOW MANY objects
   * actually moved, so the caller can say so — and say nothing when nothing did.
   *
   * `checkpoint` lays the re-verting down as one undo step. The SEED bake (a legacy blob
   * getting its map bodies for the first time) deliberately takes no checkpoint: nothing moved
   * from anywhere, there is nothing to step back to, and a stack entry for it would be a step
   * the operator never took.
   *
   * ⚠️ `count` says WHAT the caller means by «moved» (23.09.2026): the fit effect counts only
   * relocations on the sheets whose fit changed (georefTwins · movedOnSheets), because a re-bake
   * re-derives every body and some differ for reasons that are no fit's. Without it every changed
   * object counts. And the checkpoint follows the count: a re-bake that moved nothing the caller
   * counts is still written, but it is not an undo step — there is nothing to take back.
   */
  rebake: (opts?: { checkpoint?: boolean; count?: (before: TacticalObject[], after: TacticalObject[]) => number }) => number
}

/** The plan writer — `SetStateAction` plus the one option a machine writer has to pass. */
export type SetBoard = (update: SetStateAction<BoardDoc>, opts?: { gesture?: boolean }) => void

export interface ObjectStoreOptions {
  /** the plans' solved fits, read at WRITE time — a ref-backed getter, because the fits are
   *  derived far below this hook and a bake must use the current one, not the one that existed
   *  when the mutator was created. */
  getFits: () => ReadonlyMap<string, PlanFit>
  /** the layer a freshly baked map body lands on when the object has never had one */
  defaultLayer: Entity['layer']
  /** ⚠️ Bumped when a fit REALLY changes (IncidentWorkspace · fitSignature). The board view is
   *  derived THROUGH the fits, and `getFits` is a ref no memo can see into — this is what tells
   *  it a corrected georeference moved every projection on that sheet. */
  fitsVersion: number
  /** told whenever a step is laid down, so the global timeline can record it (see useUndoableDoc) */
  onCheckpoint?: (before: TacticalObject[]) => void
  /**
   * …and whenever a write moved an object BETWEEN the surfaces (tacticalObjects · anchorChanges).
   *
   * ⚠️ It is reported here because it can be reported nowhere else. The audit stream is emitted by
   * the surface the finger was on, and that surface speaks one document; an anchor flip changes
   * both, and the half it cannot see is the half a view-based replay needs to stay coherent (see
   * lib/replay). Once per gesture, not once per sample: the first fold past the deadzone performs
   * the flip and every later one finds it already made.
   */
  onAnchorChange?: (changes: AnchorChange[]) => void
  /** Committed edits made through another sheet, in the owning views' replay vocabulary. */
  onForeignSheetEdit?: (events: ForeignSheetEditEvent[]) => void
}

export interface ForeignSheetEditEvent {
  op: 'board.edit' | 'entity.edit' | 'draw.edit'
  payload: Record<string, unknown>
}

export function useObjectStore(
  init: TacticalObject[],
  readOnly: boolean,
  { getFits, defaultLayer, fitsVersion, onCheckpoint, onAnchorChange, onForeignSheetEdit }: ObjectStoreOptions,
): ObjectStore {
  const store = useUndoableDoc<TacticalObject[]>(init, readOnly, onCheckpoint)
  const { setDocRaw: setObjects } = store

  const views = useMemo(() => viewsOf(store.doc), [store.doc])
  const doc = useMemo<Doc>(() => ({ entities: views.entities, drawings: views.drawings }), [views])
  // ⚠️ Projections FIRST, the sheet's own annos after — a sheet's ink paints over what the Karte
  // lends it, the mirror of the map view putting geo-anchored objects before the baked bodies of
  // sheet-drawn ones. Each surface paints the other's work underneath its own.
  const board = useMemo(() => boardViewOf(store.doc, getFits()), [store.doc, fitsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Fold a map document back into the store. `next === view` is the no-op an updater signals by
   *  returning what it was given (the live-GPS pass does it on every poll) — passing that on
   *  would rebuild the store, and with it every identity the memos above hang off.
   *
   *  ⚠️ The fits travel WITH the fold: a Karte edit of a sheet-anchored object writes its
   *  unit-bearing fields — a Form's width, a Hubretter's reach, an Absperrkreis's radius, a
   *  Trupp's recorded breadcrumbs — back onto the anno through that plan's own fit. */
  const foldDoc = (objects: TacticalObject[], next: Doc, view: Doc, opts?: { gesture?: boolean; movedIds?: readonly string[] }): TacticalObject[] =>
    next === view ? objects : applyDocToObjects(objects, next, getFits(), opts?.gesture ?? true,
      opts?.movedIds ? new Set(opts.movedIds) : undefined)

  /**
   * Every write, wrapped so the flips it made are reported once it is done.
   *
   * ⚠️ The fold hands its answer out through a local and the CALLBACK runs after the write, not
   * inside the updater — the same shape `rebake` uses for its `moved` count, and safe for the
   * same reason: the updater runs eagerly, exactly once (useUndoableDoc). Emitting from inside it
   * would put an audit append in a function React is entitled to re-invoke.
   */
  const reporting = (write: (see: (before: TacticalObject[], after: TacticalObject[]) => void) => void) => {
    let changes: AnchorChange[] = []
    write((before, after) => { changes = anchorChanges(before, after) })
    if (changes.length) onAnchorChange?.(changes)
  }

  const setDocRaw: ObjectStore['setDocRaw'] = (a, opts) => {
    reporting((see) => setObjects((objects) => {
      const view = docViewOf(objects)
      const next = foldDoc(objects, typeof a === 'function' ? a(view) : a, view, opts)
      see(objects, next)
      return next
    }))
  }

  const commit: ObjectStore['commit'] = (updater, opts) => {
    reporting((see) => store.commit((objects) => {
      const view = docViewOf(objects)
      const next = foldDoc(objects, updater(view), view, opts)
      see(objects, next)
      return next
    }))
  }

  /** ⚠️ Checked BEFORE the commit: a commit always lays a step, and a take-over that changes
   *  nothing (the object went meanwhile, or is a line with no ground) must not leave one. */
  const reanchorToKarte = (id: string, coord?: LngLat): boolean => {
    if (readOnly) return false
    const o = store.current().find((x) => x.id === id)
    const flipped = o ? reanchoredToKarte(o, coord, defaultLayer) : null
    if (!flipped) return false
    reporting((see) => store.commit((objects) => {
      const next = objects.map((x) => (x.id === id ? flipped : x))
      see(objects, next)
      return next
    }))
    return true
  }

  /**
   * …and the plan side. Only the plans whose anno list the updater actually replaced are folded
   * and re-baked: a plan drag fires this per pointer move, and re-deriving every sheet's map
   * bodies on each one would be arithmetic nobody asked for. A key that vanished from the result
   * is an empty list, which deletes that sheet's objects — the same reading `setBoard` has always
   * had, now with the object going rather than just its anno.
   */
  /**
   * The plan gesture currently running, as a token — and the token the store's step for it was
   * laid down under.
   *
   * ⚠️ A token that is OPENED and CLOSED, not a flag. As a tri-state that only ever moved
   * «open» → «done» this latched: after the first plan gesture of a session every later
   * cross-ownership write — the seven board sweeps in useTruppActions, a plan ↶ through
   * planStepAt, a Gebäude amend — found it already «done» and laid down no undo step at all.
   *
   * While one is open, its first cross-ownership fold takes the step and the rest of the samples
   * fold into it. With none open — every writer that is not a gesture — each write is its own
   * step, which is what the Trupp sweeps, a plan ↶ and a Gebäude amend need.
   *
   * ⚠️ The SURFACE opens and closes it. A gesture's end is not something the DOM can be asked
   * about: the release writes its final frame from the same pointerup any listener would hear,
   * so watching the window closed the gesture one fold too early and the last sample became a
   * second undo step — a bar turn then half-un-turned on the first ↶.
   */
  const sheetStep = useRef<symbol | null>(null)
  const stepped = useRef<symbol | undefined>(undefined)
  const foreignPending = useRef(new Map<string, { before: TacticalObject; after: TacticalObject }>())
  const foreignReporter = useRef(onForeignSheetEdit)
  foreignReporter.current = onForeignSheetEdit
  const flushForeign = () => {
    const events: ForeignSheetEditEvent[] = []
    const current = new Map(store.current().map((o) => [o.id, o]))
    for (const { before, after } of foreignPending.current.values()) {
      if (!after.sheet || current.get(after.id)?.sheet?.planId !== after.sheet.planId || JSON.stringify(before) === JSON.stringify(after)) continue
      // Full replacement preserves field removals through JSON transport as well.
      events.push({ op: 'board.edit', payload: { id: after.id, planId: after.sheet.planId, patch: after.sheet.anno, replace: true } })
      if (after.entity) events.push({ op: 'entity.edit', payload: { id: after.id, patch: after.entity, replace: true } })
      if (after.drawing) events.push({ op: 'draw.edit', payload: { id: after.id, patch: after.drawing, replace: true } })
    }
    foreignPending.current.clear()
    if (events.length) foreignReporter.current?.(events)
  }
  const beginSheetStep = () => { flushForeign(); sheetStep.current = Symbol('sheet-step') }
  const endSheetStep = () => { sheetStep.current = null; flushForeign() }

  /**
   * …and the net under it, for the gesture that never says it ended: a plan step taken from the
   * KEYBOARD opens a token no `phase === 'end'` will ever close, and the next discrete write
   * would fold into a gesture that is long over.
   *
   * ⚠️ `setTimeout(…, 0)`, so it runs AFTER the release's own final fold, and only for the
   * PRIMARY pointer — a stray second finger lifting mid-gesture used to close the token, after
   * which a 60 Hz stream checkpointed per sample and evicted the operator's real history past
   * `historyCap` on both stacks. One listener pair for the life of the hook, removed with it.
   */
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      if (!e.isPrimary) return
      const token = sheetStep.current
      if (!token) return
      setTimeout(() => { if (sheetStep.current === token) endSheetStep() }, 0)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const setBoard: SetBoard = (a, opts) => {
    const changedOwners = new Map<string, { before: TacticalObject; after: TacticalObject }>()
    reporting((see) => setObjects((objects) => {
      const view = boardViewOf(objects, getFits())
      const next = typeof a === 'function' ? a(view) : a
      if (next === view) return objects
      let out = objects
      let foreignEdit = false
      for (const planId of new Set([...Object.keys(view), ...Object.keys(next)])) {
        const annos = next[planId] ?? []
        if (annos === view[planId]) continue
        const plan = getFits().get(planId)
        const folded = bakePlan(applyBoardToObjects(out, planId, annos, plan, defaultLayer, opts?.gesture ?? true, getFits()), planId, plan, defaultLayer)
        const foldedById = new Map(folded.map((o) => [o.id, o]))
        for (const before of out) {
          if (!before.sheet || before.sheet.planId === planId) continue
          const after = foldedById.get(before.id)
          if (after && after.sheet?.planId === before.sheet.planId && JSON.stringify(before) !== JSON.stringify(after)) {
            changedOwners.set(before.id, { before: changedOwners.get(before.id)?.before ?? before, after })
          }
        }
        foreignEdit ||= touchedForeign(out, folded, planId)
        out = folded
      }
      const gesture = sheetStep.current
      // no gesture open ⇒ a discrete write, and every one of those is its own step
      if (out !== objects && foreignEdit && (gesture === null || stepped.current !== gesture)) {
        store.checkpoint(objects)
        stepped.current = gesture ?? undefined // …the gesture's remaining samples fold into it
      }
      see(objects, out)
      return out
    }))
    // Outside the updater, like anchor reporting. Samples coalesce until the surface
    // commits its gesture; passive projection/re-bake never enters this write path.
    for (const [id, change] of changedOwners) foreignPending.current.set(id, {
      before: foreignPending.current.get(id)?.before ?? change.before, after: change.after,
    })
    if (sheetStep.current === null) flushForeign()
  }

  const rebake: ObjectStore['rebake'] = (opts) => {
    // A dry pass first: `commit` lays down a checkpoint whether or not its updater changes
    // anything, and an undo step for a fit change on a sheet nobody has drawn on is a step the
    // operator never took. ⚠️ Against the LIVE store (`current()`), the same value the updater
    // below will see — reading this render's snapshot answered about a state one write behind.
    const live = store.current()
    const baked = bakeAll(live, getFits(), defaultLayer)
    if (baked === live) return 0
    // ⚠️ Counted on the dry pass, BEFORE the write, because the count decides whether the write
    // is a step. The updater below runs eagerly against the same live store (useUndoableDoc).
    const moved = opts?.count ? opts.count(live, baked) : baked.reduce((n, o, i) => n + (o === live[i] ? 0 : 1), 0)
    const of = (objects: TacticalObject[]) => bakeAll(objects, getFits(), defaultLayer)
    if (opts?.checkpoint && moved > 0) store.commit(of); else setObjects(of)
    return moved
  }

  /**
   * ⚠️ The writers handed out keep ONE identity for the life of the store (24.09.2026).
   *
   * Each of them is a closure over this render — `store`, `readOnly`, `onAnchorChange`, the undo
   * stacks — so each render made a new one, and an effect that listed one in its deps re-ran
   * after every render. The live-GPS pass did exactly that with `setDocRaw`: its write rendered,
   * the render made a new `setDocRaw`, the effect ran again and wrote again — a render storm and
   * React #185 on every device with the vehicle feed (Übung 23.09.2026). So the identities below
   * are fixed, and each forwards to the implementation of the LATEST render through a ref,
   * which keeps every semantic the closures had: `commit` still sees the current `readOnly`,
   * `reporting` the current `onAnchorChange`, `undo` the current stack. Assigned during render
   * like `foreignReporter` above — a child's layout effect that writes must reach this render's
   * store, not the last one's.
   */
  const gestureOpen = () => store.dragging() || sheetStep.current !== null
  const impl = useRef({ setDocRaw, setBoard, beginSheetStep, endSheetStep, commit, reanchorToKarte, beginDrag: store.beginDrag, endDrag: store.endDrag, undo: store.undo, redo: store.redo, rebake, gestureOpen })
  impl.current = { setDocRaw, setBoard, beginSheetStep, endSheetStep, commit, reanchorToKarte, beginDrag: store.beginDrag, endDrag: store.endDrag, undo: store.undo, redo: store.redo, rebake, gestureOpen }
  // ⚠️ Every forwarder spreads the WHOLE parameter list, typed off the public signature, and
  // carries no cast: a hand-written `(a) => …` behind an `as` silently dropped `setBoard`'s
  // `{ gesture }` (24.09.2026), and tsc could not say so. Add an option to a writer and it
  // arrives; drop one from the implementation and this stops compiling.
  const writers = useMemo(() => ({
    setDocRaw: (...args: Parameters<ObjectStore['setDocRaw']>) => impl.current.setDocRaw(...args),
    setBoard: (...args: Parameters<ObjectStore['setBoard']>) => impl.current.setBoard(...args),
    beginSheetStep: (...args: Parameters<ObjectStore['beginSheetStep']>) => impl.current.beginSheetStep(...args),
    endSheetStep: (...args: Parameters<ObjectStore['endSheetStep']>) => impl.current.endSheetStep(...args),
    commit: (...args: Parameters<ObjectStore['commit']>) => impl.current.commit(...args),
    reanchorToKarte: (...args: Parameters<ObjectStore['reanchorToKarte']>) => impl.current.reanchorToKarte(...args),
    beginDrag: (...args: Parameters<ObjectStore['beginDrag']>) => impl.current.beginDrag(...args),
    endDrag: (...args: Parameters<ObjectStore['endDrag']>) => impl.current.endDrag(...args),
    undo: (...args: Parameters<ObjectStore['undo']>) => impl.current.undo(...args),
    redo: (...args: Parameters<ObjectStore['redo']>) => impl.current.redo(...args),
    rebake: (...args: Parameters<ObjectStore['rebake']>) => impl.current.rebake(...args),
    // read by the save path (useIncidentSync) per sample: a drag or an open plan step
    gestureOpen: () => impl.current.gestureOpen(),
  }), [])

  return {
    objects: store.doc, doc, board,
    ...writers,
    canUndo: store.canUndo, canRedo: store.canRedo,
    current: store.current,
    replaceObjects: store.replace,
  }
}

/**
 * Did this fold touch an object the sheet does not OWN — one the Karte holds and the sheet was
 * merely showing? That is what decides which undo stack is owed a step: a sheet's own
 * annotations are restored by its own history, and anything else is a store-level act.
 */
function touchedForeign(before: TacticalObject[], after: TacticalObject[], planId: string): boolean {
  const now = new Map(after.map((o) => [o.id, o]))
  for (const o of before) if (o.sheet?.planId !== planId && now.get(o.id) !== o) return true
  return false
}

/** …and what every sheet DRAWS, for the same reason: an updater must see the LIVE store. ONE
 *  builder per sheet (tacticalObjects · sheetAnnos), shared with the write seam's own «what did
 *  it look like a moment ago» — see the note there for what two orders cost. */
function boardViewOf(objects: TacticalObject[], fits: ReadonlyMap<string, PlanFit>): BoardDoc {
  const out: BoardDoc = {}
  const planIds = new Set<string>(fits.keys())
  for (const o of objects) if (o.sheet) planIds.add(o.sheet.planId)
  for (const planId of planIds) {
    const annos = sheetAnnos(objects, planId, fits.get(planId))
    if (annos.length) out[planId] = annos
  }
  return out
}

/** The Karte's document of one store snapshot. Derived per write (the render path uses the memo
 *  above) — an updater must see the LIVE store, or two writes in the same tick would each build
 *  on the pre-render one and the second would silently revert the first. */
function docViewOf(objects: TacticalObject[]): Doc {
  const { entities, drawings } = viewsOf(objects)
  return { entities, drawings }
}
