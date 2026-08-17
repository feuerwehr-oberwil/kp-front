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
  /** write + checkpoint — the one path an editing action should use */
  set: Dispatch<SetStateAction<T>>
  undo: () => { from: T; to: T } | null
  redo: () => { from: T; to: T } | null
  canUndo: boolean
  canRedo: boolean
  /** drop the history (remote/merged state arrived; it no longer applies) */
  clear: () => void
}

export function useUndoableSlice<T>(value: T, setValue: Dispatch<SetStateAction<T>>, readOnly = false): UndoableSlice<T> {
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

  const set: Dispatch<SetStateAction<T>> = (update) => {
    if (readOnly) return
    const before = latest.current
    setPast((p) => [...p, before].slice(-cap))
    setFuture([])
    const next = typeof update === 'function' ? (update as (prev: T) => T)(before) : update
    latest.current = next
    setValue(next)
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
    latest.current = to
    setValue(to)
    return { from: cur, to }
  }
  // stable (only stable setters) so callers can keep it out of effect deps
  const clear = useCallback(() => { setPast([]); setFuture([]) }, [])

  return { set, undo: () => step('past'), redo: () => step('future'), canUndo: past.length > 0, canRedo: future.length > 0, clear }
}
