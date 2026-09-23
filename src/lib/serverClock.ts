// One clock for every device in an Einsatz — the deployment's own.
//
// ⚠️ Why this exists (field report 02.09.): the Atemschutz contact clocks are the app's one
// safety-critical timer, and every one of them was `Date.now() - lastContactTime` read off the
// DEVICE. Two devices watching the SAME Trupp therefore showed two different numbers — a phone
// and a PC six seconds apart, constantly, because that is what their clocks were. Worse, the
// stamps themselves were device-local, so a tablet running ahead wrote contact times into the
// legal record that no other device (and no reconstruction) could reconcile, and the merge's
// «later wins» rule (mergeWorkspace · TRUPP_TIME_FIELDS) handed that tablet every tie.
//
// The backend already stamps EVERY /api/ response with `X-Server-Time` (main.py ·
// api_server_time). Sampling it in the fetch wrapper costs one header read per request and gives
// the whole app a shared instant: `serverNow()`.
//
// Degrading offline is the normal case, not an edge case: with no sample the offset is 0 and
// `serverNow()` IS `Date.now()`, i.e. exactly the old behaviour. A device that has been online
// once keeps the offset it learned.
//
// ⚠️ A header is only as fresh as the RESPONSE it rides on (Feueralarm 23.09.2026, root cause B).
// The service worker answers `/api/reference/…` out of its caches, and a cached response carries
// the `X-Server-Time` of the day it was stored. One of them — the plan alignments, which the
// pinned-revision CacheFirst rule swallowed — told this module the server was three days behind,
// and the old rule («any sample more than 60 s off is a real clock change, adopt it») believed
// it: «Atemschutz-Alarm beendet» went into the Verlauf stamped 20.09. 19:53 for an act at 23.09.
// 18:10, and every contact clock on the board read negative until the next request. Two
// defences, and either alone would have held:
//   1. the fetch wrapper only feeds answers that cannot have come from a cache
//      (`isFreshSampleSource`: no service-worker-cached prefix, no HTTP-cache read);
//   2. this estimator never moves the clock BACKWARD on one sample's word — see `noteServerTime`.

/** How far a sample's EARLIEST possible offset may sit above the standing estimate before the
 *  sample counts as contradicting it. Covers a request whose send time was not recorded (its
 *  whole latency then lands in the bound) and scheduler slop between `fetch()` and the socket. */
const MARGIN_MS = 1_000

/** A backward correction needs this many contradicting samples that agree with each other… */
const CONFIRM_SAMPLES = 2
/** …received at least this far apart. A burst of cached answers replayed together (one loop over
 *  several bindings) must not corroborate itself; a real clock change is still there seconds
 *  later, in every answer. */
const CONFIRM_SPAN_MS = 2_000

/** A backward correction this small is absorbed by holding `serverNow()` still until the truth
 *  catches up — the clock pauses, it never steps back. Larger ones (a device clock that was set
 *  forward by hours and is now being undone) step: holding would freeze every contact clock for
 *  that long, which is the forbidden direction dressed up as a pause. */
const HOLD_MAX_MS = 2_000

/** The device clock moving this much against the monotonic clock between two readings is a
 *  device clock STEP, not drift. */
const STEP_MS = 1_000

/**
 * device − server, in ms; positive = this device runs ahead. Null until the first sample.
 *
 * ⚠️ Tracked as the MINIMUM of the samples seen, not the latest. Each sample is inflated by the
 * response's travel time (the header is stamped when the server answers, we read it when it
 * lands), so the smallest sample is the one with the least latency in it — the best estimate we
 * can make without a round-trip protocol. It also buys the property the Atemschutz board needs:
 * an offset that only ever shrinks makes `serverNow()` only ever move FORWARD relative to the
 * device clock, so a contact clock can never jump backwards when a later sample arrives. A
 * contact clock going backwards makes the time since the last Funkkontakt look shorter than it
 * is, which is the one direction this surface must never move (see workspace · demoClockAnchor
 * for the same rule). The one way UP is a corroborated correction (`noteServerTime`).
 */
let offsetMs: number | null = null

/** A pending backward correction: the offset interval every contradicting sample so far agrees
 *  on, how many there were, and when the first and last arrived (device ms). */
let candidate: { lo: number; hi: number; count: number; first: number; last: number } | null = null

/** The last (device, monotonic) reading pair — what a device clock step is measured against. */
let anchor: { wall: number; mono: number } | null = null

/** The last value `serverNow()` handed out, for the small-correction hold. */
let lastNow: number | null = null

interface ClockSource { wall: () => number; mono: () => number }
const defaultClocks: ClockSource = {
  wall: () => Date.now(),
  // Without a monotonic clock the drift is always 0 and step detection simply never fires.
  mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
}
let clocks: ClockSource = defaultClocks

/**
 * Follow a device clock that was set BACK, so `serverNow()` does not follow it down.
 *
 * The monotonic clock cannot be set; the device clock can. When the device clock falls behind
 * the monotonic one by more than STEP_MS between two readings, somebody (NTP, the OS, a person)
 * moved it back by exactly that much — and the true device − server offset moved with it, so
 * the estimate does too and `serverNow()` stays where it was. The other direction is left
 * alone on purpose: the device clock running AHEAD of the monotonic one is also what a suspended
 * tablet looks like (the monotonic clock stops while asleep on most platforms), and treating a
 * nap as a clock step would put every stamp written offline after it behind by the nap. A
 * genuine forward step is corrected by the next server answers instead.
 */
function followDeviceStep(wall: number): void {
  const mono = clocks.mono()
  if (anchor && offsetMs !== null) {
    const drift = (wall - anchor.wall) - (mono - anchor.mono)
    if (drift < -STEP_MS) {
      offsetMs += drift
      if (candidate) candidate = { ...candidate, lo: candidate.lo + drift, hi: candidate.hi + drift }
      // `lastNow` is SERVER time and the server did not move: nothing to re-express.
    }
  }
  anchor = { wall, mono }
}

/**
 * Feed one `X-Server-Time` header (ISO-8601) into the estimate. Unparseable values are ignored —
 * no information is better than wrong information. `receivedAt` (when the answer landed) and
 * `sentAt` (when the request left, device clock) are injectable for tests; without `sentAt` the
 * request is taken to have taken no time, and MARGIN_MS absorbs the latency.
 *
 * A fresh answer brackets the true offset: the server stamped it after we sent and before we
 * read, so `sentAt − server ≤ offset ≤ receivedAt − server`. Three readings of that:
 *  - the upper bound is BELOW the estimate → the server is provably later than we thought: adopt
 *    it at once. No corroboration needed: a stored header is OLDER, which only ever makes the
 *    upper bound LARGER, so whatever the answer's source that bound is still at or above the true
 *    offset — adopting it moves the clock forward and can never overshoot.
 *  - the lower bound reaches the estimate (± MARGIN_MS) → consistent; latency, nothing to learn.
 *  - the lower bound is ABOVE it → the server stamped this before we asked, by our reckoning. Either
 *    the estimate is wrong (the device clock was set forward, the server's clock was corrected)
 *    or the answer is not fresh — a replayed cache entry, which is exactly what 23.09.2026 was.
 *    One sample cannot tell them apart, so it only NOMINATES a correction; the correction is
 *    adopted when CONFIRM_SAMPLES contradicting answers, CONFIRM_SPAN_MS apart, agree on it. A
 *    consistent answer in between withdraws the nomination: the estimate was fine after all.
 */
export function noteServerTime(
  iso: string | null | undefined,
  receivedAt: number = clocks.wall(),
  sentAt: number = receivedAt,
): void {
  if (!iso) return
  const server = Date.parse(iso)
  if (!Number.isFinite(server)) return
  followDeviceStep(receivedAt)
  const hi = receivedAt - server
  const lo = Math.min(sentAt, receivedAt) - server
  if (offsetMs === null || hi < offsetMs) {
    offsetMs = hi
    candidate = null
    return
  }
  if (lo <= offsetMs + MARGIN_MS) { candidate = null; return }
  // agreeing = the two brackets overlap (give or take the margin); the correction is then what
  // both allow, and its upper bound is adopted — the same «latency-inflated» side as a plain sample
  const c = candidate
  if (c && lo <= c.hi + MARGIN_MS && hi >= c.lo - MARGIN_MS) {
    const nlo = Math.max(c.lo, lo)
    candidate = { lo: nlo, hi: Math.max(Math.min(c.hi, hi), nlo), count: c.count + 1, first: c.first, last: receivedAt }
  } else {
    candidate = { lo, hi, count: 1, first: receivedAt, last: receivedAt }
  }
  if (candidate.count >= CONFIRM_SAMPLES && candidate.last - candidate.first >= CONFIRM_SPAN_MS) {
    offsetMs = candidate.hi
    candidate = null
  }
}

/**
 * The deployment's «now» in epoch ms — `Date.now()` corrected by the learned offset.
 *
 * Never lower than the last value it returned by up to HOLD_MAX_MS: a corroborated correction of
 * a second or two (clock drift catching up) pauses the clock instead of stepping it back.
 */
export function serverNow(): number {
  const wall = clocks.wall()
  if (offsetMs === null) return wall
  followDeviceStep(wall)
  let now = wall - offsetMs
  if (lastNow !== null && now < lastNow && lastNow - now <= HOLD_MAX_MS) now = lastNow
  lastNow = now
  return now
}

/** The deployment's «now» as an ISO string — what a record written on any device should carry. */
export function serverNowIso(): string {
  return new Date(serverNow()).toISOString()
}

/** device − server in ms (positive = device ahead), or null while nothing has been sampled.
 *  The minute-quantized warning chip has its own, coarser estimate — see useIncidentSync. */
export function serverClockOffsetMs(): number | null {
  return offsetMs
}

/**
 * Paths the service worker may answer out of a cache (vite.config · runtimeCaching: the
 * reference routes; public/sw-media-cache.js: media). Their `X-Server-Time` is whenever the
 * entry was stored. A new caching route under /api/ ⇒ extend this, or its header will be read
 * as the server's clock (serverClock.test · the vite.config tripwire).
 */
const SW_CACHED_API_PREFIXES = ['/api/reference/', '/api/media/']

/**
 * May this answer teach the clock? Only when it cannot have come out of a cache: no path the
 * service worker caches, and a fetch that bypasses the HTTP cache (`no-store` is the api
 * client's default; `reload` also never reads it). Anything else is not provably fresh.
 */
export function isFreshSampleSource(path: string, cache: RequestCache = 'no-store'): boolean {
  if (cache !== 'no-store' && cache !== 'reload') return false
  let pathname = path
  try { pathname = new URL(path, 'http://x').pathname } catch { /* keep it as given */ }
  return !SW_CACHED_API_PREFIXES.some((p) => pathname.startsWith(p))
}

/** Tests only: forget everything learned about the server's clock. */
export function resetServerClock(): void {
  offsetMs = null
  candidate = null
  anchor = null
  lastNow = null
}

/** Tests only: drive the device and monotonic clocks by hand (none = the real ones). */
export function setClockSourceForTests(src?: ClockSource): void {
  clocks = src ?? defaultClocks
  anchor = null
}
