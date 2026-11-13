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

/**
 * The Einsatzdauer as the bar prints it; '' for a start that does not parse (never «Invalid
 * Date»). `now` is the caller's ticking clock where it has one (the top bar ticks every second
 * anyway); without it the hook ticks its own — unless `idle`, for a reader that is not on screen
 * at this width (the switcher on a tablet), which then costs no re-render a second. The
 * deployment's clock (lib/serverClock), not the device's: the Einsatzdauer counts from a
 * timestamp another device wrote.
 */
export function useEinsatzuhr(startedAt?: string | null, endedAt?: string | null, now?: number, idle = false): string {
  const [ownNow, setOwnNow] = useState(() => serverNow())
  const ticking = now === undefined && !idle
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setOwnNow(serverNow()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  const at = now ?? ownNow
  const startMs = startedAt ? Date.parse(startedAt) : 0
  // An Einsatz that is OVER has a duration, not a stopwatch. It used to keep counting from
  // `now`, so an archived Einsatz opened from the Verlauf claimed «14:22» of Einsatzdauer for
  // something that lasted 40 minutes last Tuesday — the one number on the bar, wrong by days.
  const endMs = endedAt ? Date.parse(endedAt) : 0
  const stoppedAt = Number.isFinite(endMs) && endMs > startMs ? endMs : 0
  return Number.isFinite(startMs) && startMs > 0 ? fmtElapsedHM((stoppedAt || at) - startMs) : ''
}
