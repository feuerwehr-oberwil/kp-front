import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { newId } from './ids'
import { rebaseHistory, touchesCache, type HistoryStep, type RecordKey, type RecordShape } from './undoKeys'

/**
 * Undo/redo over a piece of state somebody ELSE owns.
 *
 * `useUndoableDoc` holds its document itself, which is right for the map: the doc exists for the
 * sake of being edited. The synced workspace slices are the other case — the Anwesenheit lives in
 * `useWorkspaceDoc` because it has to be serialised, merged and replayed, and it cannot move here
 * just to become undoable. So this wraps the setter instead: every write through `set` leaves a
 * checkpoint, and `undo`/`redo` push the neighbouring snapshot back through the same setter.
 *
 * ⚠️ Snapshots are WHOLE-SLICE and taken from the render's `value`, exactly like the doc's
 * history — a step back is «the list as it stood», not a reverse-patch. For the Anwesenheit that
 * is the point: one tap can open a block, close another and stamp a time, and undoing half of
 * that would be worse than undoing none.
 *
 * ⚠️ It is LOCAL and per device. The slice is shared (workspace blob), so a step back writes what
 * THIS device saw a moment ago. When remote state arrives, `rebase()` keeps only the steps the
 * timeline kept — those whose records the merge did not change — and re-lays each onto the merged
 * slice as a patch of the records it wrote (25.09.2026; until then the stack was dropped whole).
 *
 * `undo`/`redo` return the snapshot they restored (and `null` when there was nothing to do), so
 * the caller can name what changed in the Verlauf without keeping a second copy of the state.
 */
export interface UndoableSlice<T> {
  /**
   * write + checkpoint — the one path an editing action should use.
   *
   * Returns whether a NEW step was laid down, so the caller knows whether to put an entry on
   * the global timeline as well. `coalesce` is asked, with the two states, whether this write
   * belongs to the step already on the stack: a surface that persists on every KEYSTROKE (the
   * Rapport) would otherwise fill the whole history with one sentence, and ↶ would give back
   * one character at a time. Folding writes through without a checkpoint, so the step that
   * stands already grows to cover it — `false`/absent is the ordinary «this is its own step».
   */
  set: (update: SetStateAction<T>, opts?: { coalesce?: (prev: T, next: T) => boolean }) => boolean
  /** `expect` = the step the timeline entry stands for; a different top is not stepped */
  undo: (expect?: string) => { from: T; to: T } | null
  redo: (expect?: string) => { from: T; to: T } | null
  canUndo: boolean
  canRedo: boolean
  /** drop the history */
  clear: () => void
  /** the id of the step `set` laid last (the top of the ↶ side), for its timeline entry */
  topStep: () => string | null
  /** the records step `id` writes — `null` when the stack holds no such step, or no shape */
  stepKeys: (id: string) => RecordKey[] | null
  /** remote/merged state `next` arrived (and has been handed to the owner already): keep the
   *  steps `keep` accepts, re-laid onto it; drop the rest (all of them without a shape) */
  rebase: (next: T, keep: (step: string) => boolean) => void
}

export function useUndoableSlice<T>(
  value: T,
  setValue: Dispatch<SetStateAction<T>>,
  readOnly = false,
  /** Fields that ride OUTSIDE the history: given the snapshot about to be restored and the state
   *  standing right now, return what should actually be written. The Rapport's machine-written
   *  bookkeeping is the case (lib/reportUndo · keepMachineFields) — a ↶ of a typed sentence must
   *  not hand back an outstanding print job with it. Applied to `undo` and `redo` alike, so the
   *  slice's `latest` and the state the caller sees can never disagree. */
  onRestore?: (to: T, live: T) => T,
  /** how the slice is made of records (lib/undoKeys) — what lets a merge keep steps at all */
  shape?: RecordShape<T>,
): UndoableSlice<T> {
  // ⚠️ REFS, advanced synchronously (25.09.2026): a merge asks for a step's records and re-lays
  // the stacks in one tick, and the entry that steps them is pushed in the same handler as the
  // write. `depth` is only what the render shows of them.
  const past = useRef<HistoryStep<T>[]>([])
  const future = useRef<HistoryStep<T>[]>([])
  const [depth, setDepth] = useState({ past: 0, future: 0 })
  const sync = () => setDepth({ past: past.current.length, future: future.current.length })
  const cap = appConfig.defaults.historyCap
  // ⚠️ The LATEST value, not the render's. Two writes in one handler are ordinary here — assigning
  // a role fills «Name» and «Stv.» in the same commit, and each one goes through `set` — and with
  // the render's `value` both checkpoints were the same state: the first ↶ worked, the second was
  // a silent no-op with `canUndo` still true. Written during render (the value IS this render's)
  // and again on every step, so each checkpoint is the state that actually preceded its write.
  const latest = useRef(value)
  latest.current = value

  const set: UndoableSlice<T>['set'] = (update, opts) => {
    if (readOnly) return false
    const before = latest.current
    const next = typeof update === 'function' ? (update as (prev: T) => T)(before) : update
    // ⚠️ Asked BEFORE the checkpoint and with both states, because only the caller can say what
    // this write was: another letter in a Kurzbericht, or a row that appeared.
    const fold = opts?.coalesce?.(before, next) ?? false
    if (!fold) {
      past.current = [...past.current, { id: newId('s'), snap: before }].slice(-cap)
      future.current = []
      sync()
    }
    latest.current = next
    setValue(next)
    return !fold
  }
  const step = (from: 'past' | 'future', expect?: string) => {
    const stack = from === 'past' ? past.current : future.current
    const at = from === 'past' ? stack[stack.length - 1] : stack[0]
    if (readOnly || !at || (expect !== undefined && at.id !== expect)) return null
    const cur = latest.current
    if (from === 'past') {
      past.current = past.current.slice(0, -1)
      future.current = [{ id: at.id, snap: cur }, ...future.current]
    } else {
      future.current = future.current.slice(1)
      past.current = [...past.current, { id: at.id, snap: cur }]
    }
    sync()
    const put = onRestore ? onRestore(at.snap, cur) : at.snap
    latest.current = put
    setValue(put)
    return { from: cur, to: put }
  }
  // stable (only refs + stable setters) so callers can keep it out of effect deps
  const clear = useCallback(() => { past.current = []; future.current = []; setDepth({ past: 0, future: 0 }) }, [])
  const history = () => ({ past: past.current, present: latest.current, future: future.current })
  const touches = useRef(shape ? touchesCache(shape) : null)
  const rebase: UndoableSlice<T>['rebase'] = (next, keep) => {
    if (shape) {
      const laid = rebaseHistory(history(), next, keep, shape)
      past.current = laid.past; future.current = laid.future
    } else { past.current = []; future.current = [] }
    latest.current = next
    sync()
  }

  return {
    set, undo: (expect) => step('past', expect), redo: (expect) => step('future', expect),
    canUndo: depth.past > 0, canRedo: depth.future > 0, clear,
    topStep: () => past.current[past.current.length - 1]?.id ?? null,
    stepKeys: (id) => (touches.current ? touches.current(history(), id) : null),
    rebase,
  }
}
