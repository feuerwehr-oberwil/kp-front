// Adaptive cadence for the always-on live-follow polls (workspace sync + journal). These loops
// otherwise fire a network request every `livePollMs` (2 s) for the whole incident — on cellular
// that pins the radio in its high-power state permanently, which is the single biggest battery
// cost in the field. This module computes a smarter delay: fast while things are happening, easing
// off while the incident is quiet, and rarely while the tab is backgrounded — so the radio gets to
// sleep during the (common) long quiet stretches without ever making an active incident feel stale.

export interface BackoffOpts {
  /** the fast/base cadence (ms) — used while the incident is active (a change just arrived). */
  baseMs: number
  /** the ceiling the delay eases off to while nothing changes. Worst-case latency for the FIRST
   *  remote change after a quiet spell — pick a value that's fine for a quiet incident (~15 s). */
  maxMs: number
  /** consecutive poll rounds that returned nothing new. 0 right after a change → back to baseMs. */
  quietRounds: number
  /** the document is currently hidden (app backgrounded / screen off) — nothing on screen to keep
   *  fresh, so poll rarely and let the radio sleep. Snaps back on the visibility-return catch-up. */
  hidden: boolean
  /** the delay used while hidden (ms). Defaults to 60 s. */
  hiddenMs?: number
}

/**
 * Next poll delay. Hidden → `hiddenMs`. Otherwise exponential ease-off from `baseMs` (doubling per
 * quiet round) clamped to `maxMs`; a change resets `quietRounds` to 0, snapping the caller back to
 * `baseMs`. The exponent is capped so the doubling can't overflow to Infinity.
 */
export function nextPollDelay({ baseMs, maxMs, quietRounds, hidden, hiddenMs = 60_000 }: BackoffOpts): number {
  if (hidden) return hiddenMs
  const grown = baseMs * 2 ** Math.min(Math.max(0, quietRounds), 20)
  return Math.min(maxMs, grown)
}
