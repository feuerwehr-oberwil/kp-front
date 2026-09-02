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
// The HIDDEN path uses a flat `hiddenPollMs` and no wait: see `createLongPollLoop` below for why
// a backgrounded tab does not hold a connection.
//
// The loop that spends these delays lives here too (`createLongPollLoop`): the workspace sync and
// the Verlauf run the same one, and only the body of a round differs between them.

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

/** What one round is told about the loop it runs in. */
export interface LongPollRound {
  /** The document was hidden when the round started. A hidden tab must NOT ask the server to
   *  hold the request open (see the module header) — pass this straight into `wait: !hidden`. */
  hidden: boolean
  /** Aborted when the loop is restarted or torn down — including while the server is still
   *  holding the request. Pass it to the fetch, and treat `signal.aborted` after an await as
   *  "this answer is stale, don't apply it". */
  signal: AbortSignal
}

export interface LongPollLoopOpts {
  /**
   * One round: fetch, apply, and report whether the SERVER ANSWERED. `true` sends a visible tab
   * straight into the next round (the server did the waiting); `false` — offline, aborted,
   * backend down, or a round the caller skipped for its own reasons — eases the loop off via
   * `nextPollDelay`. A thrown round counts as unanswered.
   */
  round: (ctx: LongPollRound) => Promise<boolean>
  /** the fast/base cadence used on the ease-off path (usually `appConfig.sync.livePollMs`) */
  baseMs: number
  /** the ceiling that ease-off climbs to */
  maxMs: number
  /** delay while the tab is hidden — a function, because it can change under the loop (a device
   *  that is sounding the Atemschutz alarm polls faster than a sleeping one). */
  hiddenMs: () => number
  /** The tab is going away — visibility→hidden or pagehide. Flush anything that has to ride a
   *  keepalive beacon here; the loop itself drops the held request and falls back to `hiddenMs`. */
  onSuspend?: () => void
  /** The device came back online. The loop already restarts itself (pull side); this is where a
   *  caller retries its own outbox (push side). */
  onOnline?: () => void
}

export interface LongPollLoop {
  /** (Re)start after `delay` ms, invalidating any round in flight — including one the server is
   *  still holding. `start(0)` is "catch up now". */
  start: (delay: number) => void
  /** Stop for good and unregister the listeners. The loop cannot be restarted afterwards. */
  stop: () => void
}

/**
 * The live-follow loop both long-pollers run on (workspace sync · Verlauf): a generation-guarded
 * timer chain where a visible tab holds a request open and a hidden one ticks slowly.
 *
 * The loop owns the mechanics — generation counter, in-flight abort, quiet-round ease-off, and
 * the three listeners that decide when to catch up (`visibilitychange`, `online`, `pagehide`).
 * The caller owns exactly one thing: what a round DOES. That split is the point — the two
 * hand-rolled copies this replaces had already diverged by omission, one of them registering
 * `online`/`pagehide` and the other neither, so a device that came back from a dead link
 * resumed pulling minutes late on one surface and at once on the other.
 *
 * Listeners are registered on creation; nothing polls until `start()`. Always `stop()` on
 * teardown — a held 20 s request must not outlive the loop that issued it.
 */
export function createLongPollLoop({ round, baseMs, maxMs, hiddenMs, onSuspend, onOnline }: LongPollLoopOpts): LongPollLoop {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let quiet = 0    // consecutive rounds that fetched nothing (failed / skipped) → ease-off
  let gen = 0      // bumps to invalidate any in-flight async round when we (re)start or tear down
  let inflight: AbortController | null = null // the held request, so a restart can drop it

  const tick = async (myGen: number) => {
    if (stopped || myGen !== gen) return
    const ctrl = new AbortController()
    inflight = ctrl
    let answered = false
    try {
      answered = await round({ hidden: document.hidden, signal: ctrl.signal })
    } catch {
      /* a round that threw fetched nothing — the ease-off below is the whole handling */
    } finally {
      if (inflight === ctrl) inflight = null
    }
    if (stopped || myGen !== gen) return
    // Straight into the next round while the server is answering a visible tab — it does the
    // waiting for us, so the spacing is only a floor against a tight retry loop. A round that
    // never reached the server, or one the caller skipped, eases off instead: a dead backend
    // must not be hammered, and a skipped round fetched nothing to be fresh about.
    const hidden = document.hidden
    let delay: number
    if (answered && !hidden) { quiet = 0; delay = LONG_POLL_SPACING_MS }
    else {
      delay = nextPollDelay({ baseMs, maxMs, quietRounds: quiet, hidden, hiddenMs: hiddenMs() })
      quiet += 1
    }
    timer = setTimeout(() => void tick(myGen), delay)
  }

  const start = (delay: number) => {
    if (stopped) return
    gen++
    const myGen = gen
    quiet = 0
    if (timer) clearTimeout(timer)
    inflight?.abort()
    inflight = null
    timer = setTimeout(() => void tick(myGen), delay)
  }

  // Returning to the foreground: catch up immediately and resume long-polling, so a backgrounded
  // device (which was polling at hiddenMs) shows the latest state at once. Going away: drop the
  // held request and fall back to the slow no-wait cadence.
  const onVis = () => {
    if (document.visibilityState === 'visible') start(0)
    else { onSuspend?.(); start(hiddenMs()) }
  }
  // Back online: the ease-off may have parked the loop minutes out on a link that has since
  // recovered, so snap to now rather than wait the backoff out.
  const onNetOnline = () => { onOnline?.(); start(0) }
  // pagehide is the desktop-navigation / bfcache twin of visibility→hidden, and on iOS it is the
  // signal that actually fires when a PWA is swiped away. Park the loop rather than kill it: a
  // page restored from the bfcache gets its timer back, and the visibility return snaps it to 0.
  const onPageHide = () => { onSuspend?.(); start(hiddenMs()) }
  document.addEventListener('visibilitychange', onVis)
  window.addEventListener('online', onNetOnline)
  window.addEventListener('pagehide', onPageHide)

  const stop = () => {
    stopped = true
    gen++
    if (timer) clearTimeout(timer)
    timer = null
    inflight?.abort()
    inflight = null
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('online', onNetOnline)
    window.removeEventListener('pagehide', onPageHide)
  }

  return { start, stop }
}
