import { useEffect, useState } from 'react'
import { fmtElapsedHM } from './format'
import { serverNow } from './serverClock'

/* ── The Einsatzuhr ────────────────────────────────────────────────────────────────────────────
 * The bar's one clock: the running Einsatzdauer, always (13.11.2026, owner pick PLACE.5). It was a
 * per-device choice of Einsatzdauer, Uhrzeit or Einsatzbeginn, told apart only by its glyph and
 * carried for a year into every later Einsatz – while the Einsatz card shows the start AND the
 * duration («🕓 21:22 · 1 h 54») and the OS status bar shows the wall time. No menu, no pref: an
 * old stored `clockMode` is ignored (lib/prefs).
 * Two readers: the tablet/desktop top bar (TopBar · `.tb-einsatzuhr`), and on the PHONE the
 * Einsatz pill itself, where the clock is the second line under the Stichwort
 * (panels/IncidentSwitcher). */

const MINUTE_MS = 60_000
/** The longest the clock waits before it looks again. The timer aims at the minute boundary; this
 *  catches what the timer cannot see coming – a server-clock correction (lib/serverClock). A look
 *  that finds the same minute sets nothing, so it costs no render. */
const RECHECK_MS = 10_000

/**
 * The Einsatzdauer as the bar prints it; '' for a start that does not parse (never «Invalid
 * Date»). It re-renders its caller once a minute, on the boundary of the ELAPSED time (an Einsatz
 * opened at 14:02:37 flips at :37), not every second: the H:MM it prints changes no more often
 * (perf sweep 26.11.2026 – the top bar rendered whole every second for it). A page that comes back
 * from hidden or from sleep looks at once. No timer at all for an Einsatz that is over, a start
 * that does not parse, or `idle` – a reader that is not on screen at this width (the switcher on
 * a tablet, the bar on a phone). The deployment's clock (lib/serverClock), not the device's: the
 * Einsatzdauer counts from a timestamp another device wrote.
 */
export function useEinsatzuhr(startedAt?: string | null, endedAt?: string | null, idle = false): string {
  const startMs = startedAt ? Date.parse(startedAt) : 0
  const valid = Number.isFinite(startMs) && startMs > 0
  // An Einsatz that is OVER has a duration, not a stopwatch. It used to keep counting from
  // `now`, so an archived Einsatz opened from the Verlauf claimed «14:22» of Einsatzdauer for
  // something that lasted 40 minutes last Tuesday — the one number on the bar, wrong by days.
  const endMs = endedAt ? Date.parse(endedAt) : 0
  const stoppedAt = Number.isFinite(endMs) && endMs > startMs ? endMs : 0
  const running = valid && !stoppedAt && !idle
  const [, setFlips] = useState(0)
  useEffect(() => {
    if (!running) return
    let shown = Math.floor((serverNow() - startMs) / MINUTE_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = () => {
      clearTimeout(timer)
      const elapsed = serverNow() - startMs
      const minute = Math.floor(elapsed / MINUTE_MS)
      if (minute !== shown) { shown = minute; setFlips((n) => n + 1) }
      timer = setTimeout(look, Math.min(MINUTE_MS - (elapsed - minute * MINUTE_MS), RECHECK_MS))
    }
    look()
    const onVisibility = () => { if (document.visibilityState === 'visible') look() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [running, startMs])
  return valid ? fmtElapsedHM((stoppedAt || serverNow()) - startMs) : ''
}
