import type { Dropper, UndoDomain, UndoTimeline } from './undoTimeline'
import type { UndoableSlice } from './useUndoableSlice'

/**
 * Put one write over an undoable slice (`useUndoableSlice` — Mittel, Checklisten, Rapport,
 * Zeitplan) on the Einsatz's undo timeline as a DELEGATING entry: ↶/↷ step the slice's own
 * history, and `record` writes what the step did (its Verlauf row, its audit op).
 *
 * ⚠️ `histRef`, read when the step is TAKEN — never the slice object of the render that wrote.
 * That object's `undo` closes over its render's stacks, which do not yet hold the checkpoint the
 * write just laid down, so ↶ restored one snapshot too far back: the first ↶ after a fresh mount
 * found an empty stack and was dropped as «lost», and a later one restored the state the write
 * had STARTED from — a re-tick «rückgängig gemacht» stayed ticked (found 23.09.2026). The entry
 * outlives the render that pushed it; only a ref reaches the render that is current.
 *
 * The entry names the slice step it stands for (`step`, the one the write just laid) and asks the
 * slice which records that step writes (`touches`), so a remote merge drops it only when it
 * changed one of those records (lib/undoTimeline · rebase).
 */
export function pushSliceStep<T>(timeline: Pick<UndoTimeline, 'push'>, entry: {
  domain: UndoDomain
  label: string
  histRef: { readonly current: UndoableSlice<T> }
  /** runs FIRST, before the stack moves — it closes whatever fold window is still open (the
   *  Rapport's), because the step that window would fold into is the one being popped */
  onStep?: () => void
  /** say what the step did; `moved` is null when the slice had nothing to step. The return is
   *  the timeline's answer: `false` = the entry could not act and is dropped */
  record: (moved: { from: T; to: T } | null, dir: 'undo' | 'redo') => boolean
}): Dropper {
  const { domain, label, histRef, onStep, record } = entry
  const step = histRef.current.topStep() ?? undefined
  return timeline.push({
    domain,
    label,
    step,
    touches: () => (step ? histRef.current.stepKeys(step) : null),
    undo: () => { onStep?.(); return record(histRef.current.undo(step), 'undo') },
    redo: () => { onStep?.(); return record(histRef.current.redo(step), 'redo') },
  })
}
