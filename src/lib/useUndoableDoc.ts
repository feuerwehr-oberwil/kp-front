import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'

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
  /** snapshot once at the start of a drag/transform gesture (silent setDocRaw during the move) */
  beginDrag: () => void
  /** fold the whole gesture into a single undo step on release */
  endDrag: () => void
  /** step back one checkpoint; returns true if the doc changed (so the caller can log it) */
  undo: () => boolean
  /** step forward one checkpoint; returns true if the doc changed */
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  /** replace the doc wholesale and drop history (remote/merged hydrate) */
  replace: (d: D) => void
  /** The LIVE document — advanced synchronously by every write, unlike `doc`, which is a
   *  per-render snapshot. A caller that has to look before it writes must look here, or its dry
   *  run answers about a state one render behind the one its updater will actually see. */
  current: () => D
  /** Lay a value down as an undo step WITHOUT changing the document — for a writer that has
   *  already computed the state it wants to be able to come back to and is applying the change
   *  itself. `commit` cannot serve it: that decides for itself whether a step is owed, and this
   *  caller only finds out while folding (lib/useObjectStore · setBoard). */
  checkpoint: (snapshot: D) => void
}

/**
 * `onCheckpoint` is told every time a step is actually laid down – a `commit`, or a gesture folded
 * by `endDrag`. It exists so the ONE global timeline (`lib/undoTimeline`) can record that the Karte
 * moved, in the same chronology as everything else; the document's own stack keeps working exactly
 * as before and stays the thing that answers `undo()`.
 */
export function useUndoableDoc<D>(init: D, readOnly: boolean, onCheckpoint?: () => void): UndoableDoc<D> {
  const [doc, setDoc] = useState<D>(init)
  // ⚠️ The live value, advanced synchronously by every write below — `doc` (state) is a
  // per-render snapshot and only feeds renders. Reading the snapshot in commit() meant two
  // commits in the same tick each built on the pre-render doc and the second silently
  // reverted the first (Übernehmen: createCircle + the ergRings patch ate the circle).
  const docRef = useRef(doc)
  const [past, setPast] = useState<D[]>([])
  const [future, setFuture] = useState<D[]>([])
  const dragSnap = useRef<D | null>(null)
  const cap = appConfig.defaults.historyCap

  // The one write funnel: keeps docRef the per-tick truth, so writers compose instead of
  // racing. The updater runs eagerly, exactly once — never inside setDoc, where StrictMode
  // would double-invoke callers' logging side effects.
  const setDocRaw: Dispatch<SetStateAction<D>> = (a) => {
    docRef.current = typeof a === 'function' ? (a as (d: D) => D)(docRef.current) : a
    setDoc(docRef.current)
  }

  // For viewers/replay readOnly is true, so commit is a no-op — even if an editing path is
  // reached it can never change the document (defense in depth, same as before).
  const commit = (updater: (d: D) => D) => {
    if (readOnly) return
    const snap = docRef.current
    setPast((p) => [...p, snap].slice(-cap)); setFuture([]); setDocRaw(updater(snap))
    onCheckpoint?.()
  }
  const beginDrag = () => { dragSnap.current = docRef.current }
  const endDrag = () => {
    if (!dragSnap.current) return
    const snap = dragSnap.current
    setPast((p) => [...p, snap].slice(-cap)); setFuture([]); dragSnap.current = null
    onCheckpoint?.()
  }
  // ⚠️ docRef is read into a local BEFORE the setState updaters below: an updater must stay
  // pure (StrictMode re-invokes it after docRef has already advanced).
  const undo = (): boolean => {
    if (readOnly || !past.length) return false
    const cur = docRef.current
    setFuture((f) => [cur, ...f]); setDocRaw(past[past.length - 1]); setPast((p) => p.slice(0, -1))
    return true
  }
  const redo = (): boolean => {
    if (readOnly || !future.length) return false
    const cur = docRef.current
    setPast((p) => [...p, cur]); setDocRaw(future[0]); setFuture((f) => f.slice(1))
    return true
  }
  // The doc was replaced by remote/merged state, so the local undo history no longer
  // applies — undoing into it would push a stale doc and resurrect remotely-deleted content.
  // Stable (only the ref + stable setters) so callers can keep it out of effect/callback deps.
  const replace = useCallback((d: D) => { docRef.current = d; setDoc(d); setPast([]); setFuture([]) }, [])
  const checkpoint = (snapshot: D) => {
    if (readOnly) return
    setPast((p) => [...p, snapshot].slice(-cap)); setFuture([])
    onCheckpoint?.()
  }

  return { doc, current: () => docRef.current, setDocRaw, commit, beginDrag, endDrag, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0, replace, checkpoint }
}
