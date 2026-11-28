import { useSyncExternalStore } from 'react'

// One timer for every label that reads differently «today» (format · fmtWhen · todayShort): it
// fires at the next local midnight, and only while someone listens – a memo'd part that no
// longer renders with the workspace wakes itself for the one moment its words change.
const dayOf = () => new Date().toDateString()
let day = dayOf()
let timer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()

function arm() {
  const now = new Date()
  const toMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
  timer = setTimeout(() => { day = dayOf(); subs.forEach((f) => f()); arm() }, toMidnight)
}

function subscribe(cb: () => void) {
  subs.add(cb)
  if (timer === undefined) { day = dayOf(); arm() }
  return () => {
    subs.delete(cb)
    if (!subs.size) { clearTimeout(timer); timer = undefined }
  }
}

const idle = () => () => {}

/** The local day, as a string that changes at midnight: the caller renders again then.
 *  `on: false` listens to nothing – for a part whose words have no «today» form right now. */
export function useLocalDay(on = true): string {
  return useSyncExternalStore(on ? subscribe : idle, () => day)
}
