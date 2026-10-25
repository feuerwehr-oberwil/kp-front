// A half-typed entry that survives its own component being UNMOUNTED.
//
// Every «… erfassen» form in this app lives on a surface, and surfaces unmount when another one
// is chosen in the rail. That is the normal way to work: somebody starts recording a Mittel, the
// radio goes, they jump to the Verlauf, they come back — and until now the half-filled form was
// gone, with nothing said. The one thing worse than a form that is slow to fill in is one that
// silently throws away what was already in it.
//
// Module-level rather than component state, for the same reason the Rapport keeps its scroll
// position that way (`incidentSlot` below): the component that owns the value is exactly
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

// ── Kept per Einsatz: «where was I on this Einsatz», one slot per surface ──────────────────────
//
// The other kind of remembering. Not a draft but a way of LOOKING: which tab was open, whether
// «Nur Anwesende» was on, where the Rapport was scrolled to and what it will print. ONE slot per
// key, stamped with the Einsatz it was written for: writing it for another Einsatz replaces it,
// and reading it for an Einsatz it was not written for gives `null` — a fresh open. The stamp is
// what keeps two Einsätze apart, so `clearAllDrafts` leaves these alone.
//
// `memory` outlives a surface switch and dies with a reload; `session` is sessionStorage (JSON —
// keep the value plain data), which survives a reload mid-Einsatz and dies with the app.

/** A per-Einsatz slot — see `incidentSlot`. */
export type IncidentSlot<T> = {
  /** what was kept for THIS Einsatz, or null (nothing kept, or kept for another one) */
  read: (incidentId: string | undefined) => T | null
  write: (incidentId: string | undefined, value: T) => void
  forget: () => void
}

const slots = new Map<string, { incidentId?: string; value: unknown }>()

/** One remembered value per `key` for the Einsatz it was written for. Create it at module level,
 *  once per surface; `useIncidentSlot` is the `useState` over it. */
export function incidentSlot<T>(key: string, where: 'memory' | 'session' = 'memory'): IncidentSlot<T> {
  const load = (): { incidentId?: string; value?: unknown } | null | undefined => {
    if (where === 'memory') return slots.get(key)
    try {
      const raw = sessionStorage.getItem(key)
      return raw ? JSON.parse(raw) : undefined
    } catch { return undefined }
  }
  return {
    read: (incidentId) => {
      if (!incidentId) return null
      const box = load()
      return box?.incidentId === incidentId && box.value !== undefined ? (box.value as T) : null
    },
    write: (incidentId, value) => {
      if (where === 'memory') slots.set(key, { incidentId, value })
      else try { sessionStorage.setItem(key, JSON.stringify({ incidentId, value })) } catch { /* private mode */ }
    },
    forget: () => {
      if (where === 'memory') slots.delete(key)
      else try { sessionStorage.removeItem(key) } catch { /* private mode */ }
    },
  }
}

/** `useState` seeded from a per-Einsatz slot and written back on every set. */
export function useIncidentSlot<T>(slot: IncidentSlot<T>, incidentId: string | undefined, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => slot.read(incidentId) ?? fallback)
  const set = useCallback((next: T) => {
    setValue(next)
    slot.write(incidentId, next)
  }, [slot, incidentId])
  return [value, set]
}
