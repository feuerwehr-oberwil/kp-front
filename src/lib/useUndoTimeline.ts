import { useCallback, useRef, useSyncExternalStore } from 'react'
import { createUndoTimeline, type UndoTimeline } from './undoTimeline'

/** What the header pair needs to paint itself: whether it can act, and WHAT it would take back –
 *  the label the hold-tooltip promises and the flash caption confirms. */
export interface UndoTimelineState {
  canUndo: boolean
  canRedo: boolean
  /** already-localised action name, e.g. «Kontakt Trupp 2» – null when there is nothing to undo */
  undoLabel: string | null
  redoLabel: string | null
}

const EMPTY: UndoTimelineState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }

/**
 * React binding for the one global timeline: a stable instance plus a snapshot that re-renders
 * the ↶↷ pair whenever the stacks move.
 *
 * ⚠️ The snapshot is memoised per notification, not rebuilt per render – `useSyncExternalStore`
 * compares by identity and a fresh object every call is an infinite render loop.
 */
export function useUndoTimeline(): { timeline: UndoTimeline } & UndoTimelineState {
  const ref = useRef<UndoTimeline | null>(null)
  if (!ref.current) ref.current = createUndoTimeline()
  const timeline = ref.current
  const snap = useRef<UndoTimelineState>(EMPTY)

  const subscribe = useCallback((fn: () => void) => timeline.subscribe(() => { snap.current = read(timeline); fn() }), [timeline])
  const getSnapshot = useCallback(() => snap.current, [])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return { timeline, ...state }
}

function read(t: UndoTimeline): UndoTimelineState {
  return { canUndo: t.canUndo(), canRedo: t.canRedo(), undoLabel: t.peekUndo()?.label ?? null, redoLabel: t.peekRedo()?.label ?? null }
}
