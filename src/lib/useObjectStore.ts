import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { useUndoableDoc } from './useUndoableDoc'
import {
  applyBoardToObjects, applyDocToObjects, bakeAll, bakePlan, viewsOf,
  type PlanFit, type TacticalObject,
} from './tacticalObjects'
import type { Doc } from './workspace'
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
  /** every plan sheet's annotations, derived */
  board: BoardDoc
  /** raw map write, NO history checkpoint — silent updates mid-drag */
  setDocRaw: Dispatch<SetStateAction<Doc>>
  /** plan write. Silent by the same rule as before: the plan surface keeps its OWN per-document
   *  history (IncidentWorkspace · planHistory, Whiteboard · useBoardDoc), which snapshots that
   *  plan's annos and restores them straight back through here. */
  setBoard: Dispatch<SetStateAction<BoardDoc>>
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
  /** re-derive every baked map body: the georeference of some plan has changed, so every symbol
   *  standing on that sheet now stands somewhere else on the ground */
  rebake: () => void
}

export interface ObjectStoreOptions {
  /** the plans' solved fits, read at WRITE time — a ref-backed getter, because the fits are
   *  derived far below this hook and a bake must use the current one, not the one that existed
   *  when the mutator was created. */
  getFits: () => ReadonlyMap<string, PlanFit>
  /** the layer a freshly baked map body lands on when the object has never had one */
  defaultLayer: Entity['layer']
  /** told whenever a step is laid down, so the global timeline can record it (see useUndoableDoc) */
  onCheckpoint?: () => void
}

export function useObjectStore(
  init: TacticalObject[],
  readOnly: boolean,
  { getFits, defaultLayer, onCheckpoint }: ObjectStoreOptions,
): ObjectStore {
  const store = useUndoableDoc<TacticalObject[]>(init, readOnly, onCheckpoint)
  const { setDocRaw: setObjects } = store

  const views = useMemo(() => viewsOf(store.doc), [store.doc])
  const doc = useMemo<Doc>(() => ({ entities: views.entities, drawings: views.drawings }), [views])

  /** Fold a map document back into the store. `next === view` is the no-op an updater signals by
   *  returning what it was given (the live-GPS pass does it on every poll) — passing that on
   *  would rebuild the store, and with it every identity the memos above hang off.
   *
   *  ⚠️ The fits travel WITH the fold: a Karte edit of a sheet-anchored object writes its
   *  unit-bearing fields — a Form's width, a Hubretter's reach, an Absperrkreis's radius, a
   *  Trupp's recorded breadcrumbs — back onto the anno through that plan's own fit. */
  const foldDoc = (objects: TacticalObject[], next: Doc, view: Doc): TacticalObject[] =>
    next === view ? objects : applyDocToObjects(objects, next, getFits())

  const setDocRaw: Dispatch<SetStateAction<Doc>> = (a) => {
    setObjects((objects) => {
      const view = docViewOf(objects)
      return foldDoc(objects, typeof a === 'function' ? a(view) : a, view)
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
  const setBoard: Dispatch<SetStateAction<BoardDoc>> = (a) => {
    setObjects((objects) => {
      const view = viewsOf(objects).board
      const next = typeof a === 'function' ? a(view) : a
      if (next === view) return objects
      let out = objects
      for (const planId of new Set([...Object.keys(view), ...Object.keys(next)])) {
        const annos = next[planId] ?? []
        if (annos === view[planId]) continue
        out = bakePlan(applyBoardToObjects(out, planId, annos), planId, getFits().get(planId), defaultLayer)
      }
      return out
    })
  }

  const rebake = () => setObjects((objects) => bakeAll(objects, getFits(), defaultLayer))

  return {
    objects: store.doc, doc, board: views.board,
    setDocRaw, setBoard, commit,
    beginDrag: store.beginDrag, endDrag: store.endDrag,
    undo: store.undo, redo: store.redo, canUndo: store.canUndo, canRedo: store.canRedo,
    replaceObjects: store.replace, rebake,
  }
}

/** The Karte's document of one store snapshot. Derived per write (the render path uses the memo
 *  above) — an updater must see the LIVE store, or two writes in the same tick would each build
 *  on the pre-render one and the second would silently revert the first. */
function docViewOf(objects: TacticalObject[]): Doc {
  const { entities, drawings } = viewsOf(objects)
  return { entities, drawings }
}
