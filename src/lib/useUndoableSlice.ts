import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'

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
 * THIS device saw a moment ago. `clear()` exists for exactly that reason: when remote state
 * arrives the stack no longer describes anything real and has to be dropped — the same rule the
 * document's `replace()` follows.
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
  undo: () => { from: T; to: T } | null
  redo: () => { from: T; to: T } | null
  canUndo: boolean
  canRedo: boolean
  /** drop the history (remote/merged state arrived; it no longer applies) */
  clear: () => void
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
): UndoableSlice<T> {
  const [past, setPast] = useState<T[]>([])
  const [future, setFuture] = useState<T[]>([])
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
      setPast((p) => [...p, before].slice(-cap))
      setFuture([])
    }
    latest.current = next
    setValue(next)
    return !fold
  }
  const step = (from: 'past' | 'future') => {
    const stack = from === 'past' ? past : future
    if (readOnly || !stack.length) return null
    const cur = latest.current
    const to = from === 'past' ? stack[stack.length - 1] : stack[0]
    if (from === 'past') {
      setFuture((f) => [cur, ...f])
      setPast((p) => p.slice(0, -1))
    } else {
      setPast((p) => [...p, cur])
      setFuture((f) => f.slice(1))
    }
    const put = onRestore ? onRestore(to, cur) : to
    latest.current = put
    setValue(put)
    return { from: cur, to: put }
  }
  // stable (only stable setters) so callers can keep it out of effect deps
  const clear = useCallback(() => { setPast([]); setFuture([]) }, [])

  return { set, undo: () => step('past'), redo: () => step('future'), canUndo: past.length > 0, canRedo: future.length > 0, clear }
}
