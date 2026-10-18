// The Karte's scroll readout switch (components/karte/KarteScrollDebug) — DIAGNOSTIC, remove with it.
//
// Two ways on, one flag: `?debug=scroll` in a browser tab (`?debug=off` ends it), and — review
// round 8, 18.10.2026 — five quick taps on the build line at the foot of the app menu, because the
// INSTALLED app (iOS home-screen, standalone) has no address bar: the owner's search scroll worked
// in Safari and still failed there, with no way to switch the readout on. The flag lives in
// localStorage (an installed app's reload may open a fresh session, lib/swUpdate) and says so with
// a toast; nothing else shows that it exists.

import { useEffect, useRef, useState } from 'react'

const KEY = 'kp.debug.scroll'
const EVENT = 'kp-debug-scroll'
/** Taps on the build line that switch it, each within `TAP_GAP_MS` of the last. */
export const DEBUG_TAPS = 5
export const TAP_GAP_MS = 1500

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

function write(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
    // the round-5…7 flag lived in sessionStorage: «aus» must end that one too
    sessionStorage.removeItem(KEY)
  } catch { /* private mode: the switch simply does nothing */ }
}

export function setScrollDebug(on: boolean): void {
  write(on)
  window.dispatchEvent(new Event(EVENT))
}

/** Is the readout on? Reads `?debug=scroll` / `?debug=off` once (the Karte rewrites its address). */
export function scrollDebugOn(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('debug')
    // no event: this runs inside a render (useScrollDebug's first state)
    if (q === 'scroll') write(true)
    else if (q === 'off') write(false)
  } catch { /* no URL to read */ }
  return read()
}

/** The flag, live: flips when the build line is tapped with the readout's surface mounted. */
export function useScrollDebug(): boolean {
  const [on, setOn] = useState(scrollDebugOn)
  useEffect(() => {
    const sync = () => setOn(read())
    window.addEventListener(EVENT, sync)
    // another tab of the same app switched it
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return on
}

/** Counts quick taps: the `DEBUG_TAPS`-th within the gaps calls `onToggle` with the new state.
 *  Pure counter — the caller decides what a toggle shows. */
export function tapCounter(now: () => number = Date.now) {
  let n = 0, last = 0
  return (): boolean => {
    const t = now()
    n = t - last <= TAP_GAP_MS ? n + 1 : 1
    last = t
    if (n < DEBUG_TAPS) return false
    n = 0
    return true
  }
}

/** The build line's click handler: the fifth quick tap flips the readout and reports the new state. */
export function useDebugTaps(report: (on: boolean) => void): () => void {
  const count = useRef(tapCounter())
  return () => {
    if (!count.current()) return
    const on = !read()
    setScrollDebug(on)
    report(on)
  }
}
