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

/** A sample this far ABOVE the standing offset is a real clock change (the OS corrected the
 *  device clock, the tablet came back from a dead battery), not network latency — adopt it. */
const RESYNC_MS = 60_000

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
 * for the same rule).
 */
let offsetMs: number | null = null

/**
 * Feed one `X-Server-Time` header (ISO-8601) into the estimate. Unparseable values are ignored —
 * no information is better than wrong information. `receivedAt` is injectable for tests.
 */
export function noteServerTime(iso: string | null | undefined, receivedAt: number = Date.now()): void {
  if (!iso) return
  const server = Date.parse(iso)
  if (!Number.isFinite(server)) return
  const sample = receivedAt - server
  if (offsetMs === null || sample < offsetMs || sample > offsetMs + RESYNC_MS) offsetMs = sample
}

/** The deployment's «now» in epoch ms — `Date.now()` corrected by the learned offset. */
export function serverNow(): number {
  return Date.now() - (offsetMs ?? 0)
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

/** Tests only: forget everything learned about the server's clock. */
export function resetServerClock(): void {
  offsetMs = null
}
