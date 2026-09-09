import { useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import { useUndoableDoc } from './useUndoableDoc'
import {
  applyBoardToObjects, applyDocToObjects, bakeAll, bakePlan, viewsOf,
  type PlanFit, type TacticalObject,
} from './tacticalObjects'
import type { Doc } from './workspace'
import { projectedAnnos } from './planProjection'
import type { BoardDoc, Entity } from '../types'

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
   *  would have torn plan-drawn hoses off their sheet with nobody touching anything. */
  setDocRaw: (update: SetStateAction<Doc>, opts?: { gesture?: boolean }) => void
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
   */
  setBoard: Dispatch<SetStateAction<BoardDoc>>
  /** A plan step is beginning (IncidentWorkspace · rememberPlanStep). One gesture is one step on
   *  either stack, so the first cross-ownership fold after this arms is the only one that
   *  checkpoints; a discrete write outside a gesture is its own step and needs no arming. */
  beginSheetStep: () => void
  /** checkpoint the store, then apply a map update — one undo step (no-op if readOnly) */
  commit: (updater: (d: Doc) => Doc) => void
  beginDrag: () => void
  endDrag: () => void
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
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
   */
  rebake: (opts?: { checkpoint?: boolean }) => number
}

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
  onCheckpoint?: () => void
}

export function useObjectStore(
  init: TacticalObject[],
  readOnly: boolean,
  { getFits, defaultLayer, fitsVersion, onCheckpoint }: ObjectStoreOptions,
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
  const foldDoc = (objects: TacticalObject[], next: Doc, view: Doc, gesture = true): TacticalObject[] =>
    next === view ? objects : applyDocToObjects(objects, next, getFits(), gesture)

  const setDocRaw: ObjectStore['setDocRaw'] = (a, opts) => {
    setObjects((objects) => {
      const view = docViewOf(objects)
      return foldDoc(objects, typeof a === 'function' ? a(view) : a, view, opts?.gesture ?? true)
    })
  }

  const commit = (updater: (d: Doc) => Doc) => {
    store.commit((objects) => {
      const view = docViewOf(objects)
      return foldDoc(objects, updater(view), view)
    })
  }

  /**
   * …and the plan side. Only the plans whose anno list the updater actually replaced are folded
   * and re-baked: a plan drag fires this per pointer move, and re-deriving every sheet's map
   * bodies on each one would be arithmetic nobody asked for. A key that vanished from the result
   * is an empty list, which deletes that sheet's objects — the same reading `setBoard` has always
   * had, now with the object going rather than just its anno.
   */
  /** «a plan gesture is running, and its store step is already laid down» */
  const sheetStep = useRef<'open' | 'done' | null>(null)
  const beginSheetStep = () => { sheetStep.current = 'open' }

  const setBoard: Dispatch<SetStateAction<BoardDoc>> = (a) => {
    setObjects((objects) => {
      const view = boardViewOf(objects, getFits())
      const next = typeof a === 'function' ? a(view) : a
      if (next === view) return objects
      let out = objects
      for (const planId of new Set([...Object.keys(view), ...Object.keys(next)])) {
        const annos = next[planId] ?? []
        if (annos === view[planId]) continue
        const plan = getFits().get(planId)
        out = bakePlan(applyBoardToObjects(out, planId, annos, plan, defaultLayer), planId, plan, defaultLayer)
      }
      if (out !== objects && touchedForeign(objects, out)) {
        if (sheetStep.current !== 'done') store.checkpoint(objects)
        if (sheetStep.current === 'open') sheetStep.current = 'done'
      }
      return out
    })
  }

  const rebake: ObjectStore['rebake'] = (opts) => {
    // a dry pass first: `commit` lays down a checkpoint whether or not its updater changes
    // anything, and an undo step for a fit change on a sheet nobody has drawn on is a step
    // the operator never took
    if (bakeAll(store.doc, getFits(), defaultLayer) === store.doc) return 0
    let moved = 0
    const of = (objects: TacticalObject[]) => {
      const next = bakeAll(objects, getFits(), defaultLayer)
      moved = next === objects ? 0 : next.reduce((n, o, i) => n + (o === objects[i] ? 0 : 1), 0)
      return next
    }
    // ⚠️ The updater runs eagerly, exactly once (useUndoableDoc), so `moved` is set by the time
    // this returns — and it is measured against the LIVE store, not this render's snapshot.
    if (opts?.checkpoint) store.commit(of); else setObjects(of)
    return moved
  }

  return {
    objects: store.doc, doc, board,
    setDocRaw, setBoard, beginSheetStep, commit,
    beginDrag: store.beginDrag, endDrag: store.endDrag,
    undo: store.undo, redo: store.redo, canUndo: store.canUndo, canRedo: store.canRedo,
    replaceObjects: store.replace, rebake,
  }
}

/**
 * Did this fold touch an object the sheet does not OWN — one the Karte holds and the sheet was
 * merely showing? That is what decides which undo stack is owed a step: a sheet's own
 * annotations are restored by its own history, and anything else is a store-level act.
 */
function touchedForeign(before: TacticalObject[], after: TacticalObject[]): boolean {
  const now = new Map(after.map((o) => [o.id, o]))
  for (const o of before) if (!o.sheet && now.get(o.id) !== o) return true
  return false
}

/** …and what every sheet DRAWS, for the same reason: an updater must see the LIVE store. */
function boardViewOf(objects: TacticalObject[], fits: ReadonlyMap<string, PlanFit>): BoardDoc {
  const out: BoardDoc = {}
  for (const [planId, plan] of fits) {
    const projected = projectedAnnos(objects, plan)
    if (projected.length) out[planId] = projected
  }
  for (const [planId, annos] of Object.entries(viewsOf(objects).board)) {
    out[planId] = out[planId] ? [...out[planId], ...annos] : annos
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
