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
}

export function useUndoableDoc<D>(init: D, readOnly: boolean): UndoableDoc<D> {
  const [doc, setDocRaw] = useState<D>(init)
  const [past, setPast] = useState<D[]>([])
  const [future, setFuture] = useState<D[]>([])
  const dragSnap = useRef<D | null>(null)
  const cap = appConfig.defaults.historyCap

  // For viewers/replay readOnly is true, so commit is a no-op — even if an editing path is
  // reached it can never change the document (defense in depth, same as before).
  const commit = (updater: (d: D) => D) => {
    if (readOnly) return
    setPast((p) => [...p, doc].slice(-cap)); setFuture([]); setDocRaw(updater(doc))
  }
  const beginDrag = () => { dragSnap.current = doc }
  const endDrag = () => {
    if (!dragSnap.current) return
    const snap = dragSnap.current
    setPast((p) => [...p, snap].slice(-cap)); setFuture([]); dragSnap.current = null
  }
  const undo = (): boolean => {
    if (readOnly || !past.length) return false
    setFuture((f) => [doc, ...f]); setDocRaw(past[past.length - 1]); setPast((p) => p.slice(0, -1))
    return true
  }
  const redo = (): boolean => {
    if (readOnly || !future.length) return false
    setPast((p) => [...p, doc]); setDocRaw(future[0]); setFuture((f) => f.slice(1))
    return true
  }
  // The doc was replaced by remote/merged state, so the local undo history no longer
  // applies — undoing into it would push a stale doc and resurrect remotely-deleted content.
  // Stable (only stable setters) so callers can keep it out of effect/callback deps.
  const replace = useCallback((d: D) => { setDocRaw(d); setPast([]); setFuture([]) }, [])

  return { doc, setDocRaw, commit, beginDrag, endDrag, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0, replace }
}
