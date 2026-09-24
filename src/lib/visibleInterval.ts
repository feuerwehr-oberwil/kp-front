// A poll cadence that sleeps while nobody can see the page (perf sweep 23.09.2026).
//
// The read-only live feeds (Fahrzeuge, Standorte, Fahrzeugspuren — lib/useFeedPoll) and the
// weather ran their setInterval whatever the page's visibility: a desktop tab in the background
// or an Android PWA behind another app kept fetching every 15 s for a screen nobody was looking
// at. iOS suspends a hidden page's timers anyway, so this only brings the rest of the fleet in
// line. On the way back the round runs AT ONCE, so what the operator sees on return is fresh.
//
// ⚠️ Only for feeds whose sole consumer is the screen. The alarm clocks (lib/alarm), the
// Atemschutz host and the workspace/journal live-follow have their own hidden-page rules
// (lib/pollBackoff · hiddenMs, the alarm's service-worker path) and must never use this.

/** Run `round` now and every `everyMs` while the page is visible; pause while it is hidden and
 *  run at once when it comes back. Returns the stop, which also drops the listener.
 *  `leading: false` skips the at-once round (on start and on return) — for a timer that JUDGES
 *  a feed rather than fetching it, which must give the feed's own return round a cadence to land
 *  before it looks (useVehiclePositions · staleness). */
export function visibleInterval(round: () => void, everyMs: number, { leading = true }: { leading?: boolean } = {}): () => void {
  let timer: ReturnType<typeof setInterval> | null = null
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const pause = () => { if (timer != null) { clearInterval(timer); timer = null } }
  const resume = () => { if (leading) round(); timer = setInterval(round, everyMs) }
  const onVisibility = () => {
    if (hidden()) pause()
    else if (timer == null) resume() // hidden → visible; a repeated «visible» is not a return
  }
  if (!hidden()) resume()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  return () => {
    pause()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }
}
