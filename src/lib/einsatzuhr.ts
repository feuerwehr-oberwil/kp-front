import { useEffect, useState } from 'react'
import { fmtElapsedHM, formatTime } from './format'
import { serverNow } from './serverClock'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from './prefs'

/* ── The Einsatzuhr ────────────────────────────────────────────────────────────────────────────
 * The bar's one clock: the running Einsatzdauer, the wall clock or the Einsatzbeginn, picked from
 * a LABELLED menu (each mode named, its value, a tick on the active one) rather than a blind
 * tap-to-cycle, so the reading is never ambiguous at 3am. The choice persists per device.
 * Two readers since 07.10.2026 (UI sweep, owner pick B3 · D): the tablet/desktop top bar
 * (TopBar · `.tb-einsatzuhr`), and on the PHONE the Einsatz pill itself, where the clock is the
 * second line under the Stichwort and the mode menu opens from the Einsatz card's Beginn pill
 * (panels/IncidentSwitcher). Both read and write the SAME choice through `useClockMode`; the
 * menu is components/Einsatzuhr · EinsatzuhrMenu. */

export type ClockMode = 'elapsed' | 'now' | 'start'
export const CLOCK_MODES: ClockMode[] = ['elapsed', 'now', 'start']
// distinct glyph per mode so the icon itself says which time you're reading: elapsed duration
// (hourglass), current wall time (plain clock), start of the operation (flag).
export const CLOCK_ICON: Record<ClockMode, string> = { elapsed: 'hourglass', now: 'clock', start: 'flag' }

/** every mounted reader, so a pick in one is the reading in all of them */
const readers = new Set<(m: ClockMode) => void>()

function useClockMode(): [ClockMode, (m: ClockMode) => void] {
  const [mode, setMode] = useState<ClockMode>(() => loadPrefs().clockMode ?? 'elapsed')
  useEffect(() => {
    readers.add(setMode)
    return () => { readers.delete(setMode) }
  }, [])
  const pick = (m: ClockMode) => {
    savePrefs({ ...loadPrefs(), clockMode: m })
    readers.forEach((set) => set(m))
  }
  return [mode, pick]
}

export interface Einsatzuhr {
  mode: ClockMode
  pick: (m: ClockMode) => void
  /** the reading in the chosen mode; '' for a start that does not parse (never «Invalid Date») */
  text: string
  /** the reading in any mode — the menu lists all three */
  value: (m: ClockMode) => string
  label: Record<ClockMode, string>
}

/**
 * `now` is the caller's ticking clock where it has one (the top bar ticks every second anyway);
 * without it the hook ticks its own — unless `idle`, for a reader that is not on screen at this
 * width (the switcher on a tablet), which then costs no re-render a second. The deployment's
 * clock (lib/serverClock), not the device's: the Einsatzdauer counts from a timestamp another
 * device wrote.
 */
export function useEinsatzuhr(startedAt?: string | null, endedAt?: string | null, now?: number, idle = false): Einsatzuhr {
  const [mode, pick] = useClockMode()
  const [ownNow, setOwnNow] = useState(() => serverNow())
  const ticking = now === undefined && !idle
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setOwnNow(serverNow()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  const at = now ?? ownNow
  const E = appConfig.copy.einsatzuhr
  const startMs = startedAt ? Date.parse(startedAt) : 0
  // An Einsatz that is OVER has a duration, not a stopwatch. It used to keep counting from
  // `now`, so an archived Einsatz opened from the Verlauf claimed «14:22» of Einsatzdauer for
  // something that lasted 40 minutes last Tuesday — the one number on the bar, wrong by days.
  const endMs = endedAt ? Date.parse(endedAt) : 0
  const stoppedAt = Number.isFinite(endMs) && endMs > startMs ? endMs : 0
  const value = (m: ClockMode) =>
    m === 'now' ? formatTime(new Date(at), true)
      : m === 'start' ? formatTime(new Date(startMs))
        : fmtElapsedHM((stoppedAt || at) - startMs)
  const text = Number.isFinite(startMs) && startMs > 0 ? value(mode) : ''
  return { mode, pick, text, value, label: { elapsed: E.modeElapsed, now: E.modeNow, start: E.modeStart } }
}

