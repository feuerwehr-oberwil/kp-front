import { useEffect } from 'react'
import { loadPrefs, applyTheme, resolveTheme } from './prefs'
import type { Coord } from './daylight'

// When the colour-scheme preference is 'auto', keep the day/night theme in step with
// local daylight at the incident coordinate — re-checking periodically so the UI flips
// itself at dusk during a long incident, with no action from the EL (the 3am tenet).
// Explicit 'day'/'night' overrides are left untouched. Re-reads the pref each tick so a
// manual change (or switch back to auto) takes effect without extra wiring.
const RECHECK_MS = 10 * 60 * 1000 // 10 min — dusk doesn't need finer granularity

export function useAutoTheme(coord: Coord | null): void {
  const lng = coord?.[0]
  const lat = coord?.[1]
  useEffect(() => {
    const apply = () => {
      if ((loadPrefs().theme ?? 'auto') !== 'auto') return // manual override wins
      applyTheme(resolveTheme('auto', lng != null && lat != null ? [lng, lat] : null, new Date()))
    }
    apply()
    const id = setInterval(apply, RECHECK_MS)
    return () => clearInterval(id)
  }, [lng, lat])
}
