import { useSyncExternalStore } from 'react'
import { serverNow } from './serverClock'

// One shared clock for what ages by the minute (a Messpunkt's reading going «old», TacticalSymbol ·
// ReadingPill): a single interval for every subscriber, running only while someone listens, so a
// map full of other symbols never re-renders for it.
const TICK_MS = 20_000
let now = serverNow()
let timer: ReturnType<typeof setInterval> | undefined
const subs = new Set<() => void>()

function subscribe(cb: () => void) {
  subs.add(cb)
  if (!timer) {
    now = serverNow()
    timer = setInterval(() => { now = serverNow(); subs.forEach((f) => f()) }, TICK_MS)
  }
  return () => {
    subs.delete(cb)
    if (!subs.size) { clearInterval(timer); timer = undefined }
  }
}

/** The server-aligned time in ms, refreshed every 20 s. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => now)
}
