// «Üben»: what this device remembers – the drill running now, the drills done here, and whether
// the «Üben» sheet stands open. Per DEVICE (localStorage), like `kp.demo.welcomed`: tablets and
// kiosk logins are shared, an account is not a person, and the practice Einsatz itself is per
// device (lib/practice). A drill finished with «Lösung» counts as done, without a mark (owner,
// 19.11.2026).
//
// One tiny external store, read with `useUeben()`: the menus open the sheet, App starts a drill,
// the runner inside the practice Einsatz follows it – none of them needs to hand props to the
// others.

import { useSyncExternalStore } from 'react'
import { isDrillId } from './catalogue'
import type { DrillId } from './model'

const DRILL_KEY = 'kp.ueben.drill'
const DONE_KEY = 'kp.ueben.done'

export interface UebenState {
  /** the drill on the card, null = the practice Einsatz without one */
  drill: DrillId | null
  /** bumped on every start, so starting the same drill again re-runs it */
  run: number
  /** this run is «Nochmals»: the intro card was read a moment ago and is skipped */
  again: boolean
  done: ReadonlySet<DrillId>
  sheetOpen: boolean
}

function read<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : parse(raw)
  } catch { return fallback }
}
function write(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* private mode: the drill is simply not remembered */ }
}

const parseDone = (raw: string): ReadonlySet<DrillId> => {
  const v: unknown = JSON.parse(raw)
  return new Set(Array.isArray(v) ? v.filter(isDrillId) : [])
}

let state: UebenState = {
  drill: read(DRILL_KEY, (raw) => (isDrillId(raw) ? raw : null), null),
  run: 0,
  again: false,
  done: read(DONE_KEY, parseDone, new Set<DrillId>()),
  sheetOpen: false,
}
const listeners = new Set<() => void>()
function set(next: Partial<UebenState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export const uebenState = (): UebenState => state
export function useUeben(): UebenState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, uebenState, uebenState)
}

export const openUebenSheet = () => set({ sheetOpen: true })
export const closeUebenSheet = () => set({ sheetOpen: false })

/** Put `id` on the card (App opens the practice Einsatz around it). `again` («Nochmals») skips
 *  the intro card. */
export function startDrill(id: DrillId, opts: { again?: boolean } = {}): void {
  write(DRILL_KEY, id)
  set({ drill: id, run: state.run + 1, again: !!opts.again, sheetOpen: false })
}
/** The card shows no drill any more (the practice Einsatz stays). */
export function stopDrill(): void {
  write(DRILL_KEY, null)
  set({ drill: null })
}
export function markDone(id: DrillId): void {
  if (state.done.has(id)) return
  const done = new Set(state.done).add(id)
  write(DONE_KEY, JSON.stringify([...done]))
  set({ done })
}
