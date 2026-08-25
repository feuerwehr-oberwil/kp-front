// Cadence for the live-follow loops (workspace sync + journal) when they are NOT long-polling.
//
// The normal case no longer needs a cadence at all: a visible tab asks with `?wait=1`, the server
// holds the request until something changes (backend app/live_wait), and the loop goes straight
// into the next round. Latency is the write's commit time, and a quiet incident costs one request
// per ~20 s per loop instead of one every 2–15 s.
//
// Two paths still tick on a timer, and that is what this module sizes:
// · the ERROR path — the request didn't reach the server (offline, half-open link, a backend
//   that's restarting). Rounds must ease off there, or a dead server is hammered at the spacing
//   interval for as long as the incident is open.
// · the DIRTY-SKIP path — an editor with unsynced local edits skips the round entirely (its own
//   flush owns that merge). Nothing is fetched, so there is nothing to hold a connection open
//   FOR; the loop just re-checks, easing off exactly as it did before.
// The HIDDEN path uses a flat `hiddenPollMs` and no wait: see the loops themselves for why a
// backgrounded tab does not hold a connection.

/** Spacing between two back-to-back long-poll rounds of a visible tab. Not a cadence — the
 *  server does the waiting — just a floor, so a round that returns instantly (a 304 the moment
 *  it's issued, an immediately-failing preflight) can't spin the loop into a tight retry. */
export const LONG_POLL_SPACING_MS = 250

export interface BackoffOpts {
  /** the fast/base cadence (ms) — the first retry after a failed or skipped round. */
  baseMs: number
  /** the ceiling the delay eases off to while rounds stay unproductive. */
  maxMs: number
  /** consecutive rounds that fetched nothing (failed, or skipped as dirty). 0 → back to baseMs. */
  quietRounds: number
  /** the document is currently hidden (app backgrounded / screen off) — nothing on screen to keep
   *  fresh, so poll rarely and let the radio sleep. Snaps back on the visibility-return catch-up. */
  hidden: boolean
  /** the delay used while hidden (ms). Defaults to 60 s. */
  hiddenMs?: number
}

/**
 * Next delay for a loop that is not holding a connection. Hidden → `hiddenMs`. Otherwise
 * exponential ease-off from `baseMs` (doubling per unproductive round) clamped to `maxMs`; a
 * productive round resets `quietRounds` to 0, snapping the caller back to `baseMs`. The exponent
 * is capped so the doubling can't overflow to Infinity.
 */
export function nextPollDelay({ baseMs, maxMs, quietRounds, hidden, hiddenMs = 60_000 }: BackoffOpts): number {
  if (hidden) return hiddenMs
  const grown = baseMs * 2 ** Math.min(Math.max(0, quietRounds), 20)
  return Math.min(maxMs, grown)
}
