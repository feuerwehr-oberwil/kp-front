// A half-typed entry that survives its own component being UNMOUNTED.
//
// Every «… erfassen» form in this app lives on a surface, and surfaces unmount when another one
// is chosen in the rail. That is the normal way to work: somebody starts recording a Mittel, the
// radio goes, they jump to the Verlauf, they come back — and until now the half-filled form was
// gone, with nothing said. The one thing worse than a form that is slow to fill in is one that
// silently throws away what was already in it.
//
// Module-level rather than component state, for the same reason the Rapport keeps its scroll
// position that way (ReportPreflight · savedScroll): the component that owns the value is exactly
// the thing that goes away. Not persisted to disk — a draft is a thing you are in the middle of,
// not a record; it belongs to this session and this incident, and a reload is a fresh start.
//
// ⚠️ Every draft is dropped when the INCIDENT changes (`clearAllDrafts`, called from
// IncidentWorkspace). Two Einsätze in one session must not hand each other's half-typed Mittel
// back — that is the sort of thing nobody would ever suspect, and it would put a Mittel on the
// wrong rapport. Done centrally rather than by keying every form with an id, so a form added
// later cannot forget to do it.

import { useCallback, useState } from 'react'

const store = new Map<string, unknown>()

/** Drop a kept draft — call when the form is submitted or deliberately abandoned. */
export function clearDraft(key: string): void {
  store.delete(key)
}

/** Drop EVERY kept draft — the incident changed, and nothing typed for the old one belongs to
 *  the new one. */
export function clearAllDrafts(): void {
  store.clear()
}

/** Read a kept draft without subscribing (for seeding several `useState`s at once). */
export function readDraft<T>(key: string, empty: T): T {
  const v = store.get(key)
  return v === undefined ? empty : (v as T)
}

/** Write a kept draft. Cheap enough to call from an effect on every keystroke. */
export function keepDraft<T>(key: string, value: T): void {
  store.set(key, value)
}

/**
 * `useState` whose value outlives the component. Same signature as `useState`, plus a `clear()`
 * that forgets the draft AND resets the field — use it when the form is submitted or cancelled,
 * so the next open starts empty rather than on somebody else's abandoned entry.
 */
export function useKeptState<T>(key: string, empty: T): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => readDraft(key, empty))
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      store.set(key, v)
      return v
    })
  }, [key])
  const clear = useCallback(() => { store.delete(key); setValue(empty) }, [key, empty])
  return [value, set, clear]
}
