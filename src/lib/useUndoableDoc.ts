import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { newId } from './ids'
import { rebaseHistory, rebasePending, touchesCache, type HistoryStep, type RecordKey, type RecordShape } from './undoKeys'

// The undoable-document funnel, extracted from App's god component. Owns the doc plus
// its past/future history stacks and the single mutation paths (commit + gesture fold).
// Pure of any audit/journal concern: undo()/redo() report whether they acted so the
// caller can add its own log/emit side-effects (which depend on App-level state).

export interface UndoableDoc<D> {
  doc: D
  /** raw write, NO history checkpoint — silent updates mid-drag, or wholesale hydrate */
  setDocRaw: Dispatch<SetStateAction<D>>
  /** checkpoint the current doc, then apply the update — one undo step (no-op if readOnly) */
  commit: (updater: (d: D) => D) => void
  /** snapshot once at the start of a drag/transform gesture (silent setDocRaw during the move).
   *  Answers the gesture's token, for a caller that ends it with `endDrag(token)` / `dropDrag`. */
  beginDrag: () => number
  /** fold the whole gesture into a single undo step on release; answers whether a step was laid.
   *  With its `token` it ends only THAT gesture – a newer one that took the slot is left alone –
   *  and lays NO step when a ↶ / ↷ ran while it was open: the history already holds the truth,
   *  and a step from the old snapshot would undo the ↶'s work on ↶ and clear ↷ (a Notiz typed
   *  through a ↶, IncidentWorkspace · noteTextEnd). */
  endDrag: (token?: number) => boolean
  /** end gesture `token` with NO step, if it is still the open one – a Notiz a ↶ or another
   *  device took away while it was typed */
  dropDrag: (token: number) => void
  /** is a `beginDrag` gesture open right now (read live, not a render snapshot) */
  dragging: () => boolean
  /** step back one checkpoint; returns true if the doc changed (so the caller can log it).
   *  `expect` names the step the caller means (its timeline entry's `step`): when the top of the
   *  stack is a different one, nothing happens and the answer is `false`. */
  undo: (expect?: string) => boolean
  /** step forward one checkpoint; returns true if the doc changed */
  redo: (expect?: string) => boolean
  canUndo: boolean
  canRedo: boolean
  /** replace the doc wholesale and drop history (a different document altogether) */
  replace: (d: D) => void
  /**
   * A remote merge produced `next`: take it, and keep every step `keep` accepts, re-laid onto it
   * as a patch of the records that step wrote (lib/undoKeys · rebaseHistory). Needs the `shape`
   * the hook was given; without one the history is dropped, as `replace` does.
   */
  rebase: (next: D, keep: (step: string) => boolean) => void
  /** the records step `id` writes, or `null` when the stack holds no such step (or no shape) */
  stepKeys: (id: string) => RecordKey[] | null
  /** The LIVE document — advanced synchronously by every write, unlike `doc`, which is a
   *  per-render snapshot. A caller that has to look before it writes must look here, or its dry
   *  run answers about a state one render behind the one its updater will actually see. */
  current: () => D
  /** Lay a value down as an undo step WITHOUT changing the document — for a writer that has
   *  already computed the state it wants to be able to come back to and is applying the change
   *  itself. `commit` cannot serve it: that decides for itself whether a step is owed, and this
   *  caller only finds out while folding (lib/useObjectStore · setBoard). */
  checkpoint: (snapshot: D) => string | null
}

/**
 * `onCheckpoint` is told every time a step is actually laid down – a `commit`, or a gesture folded
 * by `endDrag` – with the step's id and the document before and after it (the after is the live
 * document at that moment; a `checkpoint` caller may not have written yet, so it can equal the
 * before). The two states are what lets the ↶ name a step its writer left unnamed (lib/undoStepWords). It exists so the ONE global timeline (`lib/undoTimeline`) can
 * record that the Karte moved, in the same chronology as everything else; the document's own stack
 * keeps working exactly as before and stays the thing that answers `undo()`.
 *
 * `shape` says how the document is made of records (lib/undoKeys). With it, a remote merge keeps
 * the steps it did not invalidate (`rebase`); without it, a merge drops the history.
 */
export function useUndoableDoc<D>(init: D, readOnly: boolean, onCheckpoint?: (step: string, before: D, after: D) => void, shape?: RecordShape<D>): UndoableDoc<D> {
  const [doc, setDoc] = useState<D>(init)
  // ⚠️ The live value, advanced synchronously by every write below — `doc` (state) is a
  // per-render snapshot and only feeds renders. Reading the snapshot in commit() meant two
  // commits in the same tick each built on the pre-render doc and the second silently
  // reverted the first (Übernehmen: createCircle + the ergRings patch ate the circle).
  const docRef = useRef(doc)
  // ⚠️ The stacks are REFS, advanced synchronously like `docRef` (25.09.2026): a merge asks for a
  // step's records and re-lays the stacks in the same tick, and a render-snapshot stack would
  // answer about the state one render behind. `depth` is only what the render shows of them.
  const past = useRef<HistoryStep<D>[]>([])
  const future = useRef<HistoryStep<D>[]>([])
  const [depth, setDepth] = useState({ past: 0, future: 0 })
  const bump = () => setDepth({ past: past.current.length, future: future.current.length })
  const dragSnap = useRef<D | null>(null)
  const cap = appConfig.defaults.historyCap

  // The one write funnel: keeps docRef the per-tick truth, so writers compose instead of
  // racing. The updater runs eagerly, exactly once — never inside setDoc, where StrictMode
  // would double-invoke callers' logging side effects. Read-only takes nothing here either
  // (RBAC audit, 22.10.2026): a hydrate goes through `replace`/`rebase`, and the georef re-bake
  // never runs read-only (useGeorefFits).
  const setDocRaw: Dispatch<SetStateAction<D>> = (a) => {
    if (readOnly) return
    docRef.current = typeof a === 'function' ? (a as (d: D) => D)(docRef.current) : a
    setDoc(docRef.current)
  }
  /** lay `snap` down as a new step and tell the timeline — the ONE place a step is born */
  const lay = (snap: D) => {
    const id = newId('k')
    past.current = [...past.current, { id, snap }].slice(-cap)
    future.current = []
    bump()
    return id
  }

  // For viewers/replay readOnly is true, so commit is a no-op — even if an editing path is
  // reached it can never change the document (defense in depth, same as before).
  const commit = (updater: (d: D) => D) => {
    if (readOnly) return
    const snap = docRef.current
    const id = lay(snap)
    setDocRaw(updater(snap))
    onCheckpoint?.(id, snap, docRef.current)
  }
  // the open gesture's token, and whether a ↶ / ↷ ran while it was open (see endDrag)
  const dragToken = useRef(0)
  const dragStepped = useRef(false)
  const beginDrag = () => { dragSnap.current = docRef.current; dragStepped.current = false; return ++dragToken.current }
  const endDrag = (token?: number): boolean => {
    if (token !== undefined && token !== dragToken.current) return false
    const snap = dragSnap.current
    dragSnap.current = null
    if (!snap || readOnly || (token !== undefined && dragStepped.current)) return false
    const id = lay(snap) // ⚠️ not inside `onCheckpoint?.(…)`: an absent callback skips its arguments
    onCheckpoint?.(id, snap, docRef.current)
    return true
  }
  const dropDrag = (token: number) => { if (token === dragToken.current) dragSnap.current = null }
  const undo = (expect?: string): boolean => {
    const top = past.current[past.current.length - 1]
    if (readOnly || !top || (expect !== undefined && top.id !== expect)) return false
    past.current = past.current.slice(0, -1)
    future.current = [{ id: top.id, snap: docRef.current }, ...future.current]
    dragStepped.current = true
    setDocRaw(top.snap); bump()
    return true
  }
  const redo = (expect?: string): boolean => {
    const next = future.current[0]
    if (readOnly || !next || (expect !== undefined && next.id !== expect)) return false
    future.current = future.current.slice(1)
    past.current = [...past.current, { id: next.id, snap: docRef.current }]
    dragStepped.current = true
    setDocRaw(next.snap); bump()
    return true
  }
  // Replaced by a different document altogether, so the local undo history no longer applies —
  // undoing into it would push a stale doc and resurrect remotely-deleted content.
  // Stable (only refs + stable setters) so callers can keep it out of effect/callback deps.
  const replace = useCallback((d: D) => {
    docRef.current = d; setDoc(d); past.current = []; future.current = []; bump()
  }, [])
  const rebase = (next: D, keep: (step: string) => boolean) => {
    if (!shape) {
      replace(next)
      if (dragSnap.current !== null) dragSnap.current = next
      return
    }
    const present = docRef.current
    const laid = rebaseHistory({ past: past.current, present, future: future.current }, next, keep, shape)
    // an open gesture's starting point moves with it (see rebasePending) — or its step would
    // carry the pre-merge state of everything back when the finger lifts
    if (dragSnap.current) dragSnap.current = rebasePending(dragSnap.current, present, next, shape)
    past.current = laid.past; future.current = laid.future
    docRef.current = next; setDoc(next); bump()
  }
  const touches = useRef(shape ? touchesCache(shape) : null)
  const stepKeys = (id: string): RecordKey[] | null =>
    touches.current ? touches.current({ past: past.current, present: docRef.current, future: future.current }, id) : null
  const checkpoint = (snapshot: D): string | null => {
    if (readOnly) return null
    const id = lay(snapshot)
    onCheckpoint?.(id, snapshot, docRef.current)
    return id
  }

  return {
    doc, current: () => docRef.current, setDocRaw, commit, beginDrag, endDrag, dropDrag, dragging: () => dragSnap.current !== null,
    undo, redo, canUndo: depth.past > 0, canRedo: depth.future > 0, replace, rebase, stepKeys, checkpoint,
  }
}
