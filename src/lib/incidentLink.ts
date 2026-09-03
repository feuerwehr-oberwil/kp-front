// Einsatz-Link (/l/<token>) — the token exchange behind the login-less, read-only session an
// external alerting system links to from the alert it sends out. A responder taps it on a
// personal phone, in the dark, once every few months; the whole surface is one screen and it
// has to be right the first time.
//
// Everything decidable lives HERE rather than in the screen: what each HTTP status means to the
// person holding the phone, and the retry policy for the one failure that may fix itself on its
// own. The screen is then a pure render of one state. Reading the token out of the address and
// telling the three kinds of link apart is lib/linkMode's — every request asks that same module
// which session this page speaks with, so the two can never disagree.

import { ApiError, apiPost } from './api'

/**
 * Why the link could not be opened — a responder-facing reason, not an HTTP status.
 *
 * `notReady` deliberately covers ALL of the backend's 404s (incident closed, archived, or not
 * yet ingested by kp-front). The backend answers one status for the three on purpose, so a
 * link can't be used to probe which incidents exist; the UI must not undo that by guessing.
 * From the responder's side they also collapse into the same instruction anyway: this Einsatz
 * isn't on this device, wait a moment or ask the Einsatzleitung.
 */
export type LinkFailure = 'disabled' | 'invalid' | 'notReady' | 'offline' | 'error'

export type LinkExchange =
  | { ok: true; incidentId: string }
  | { ok: false; reason: LinkFailure }

/**
 * Trade the link token for the httpOnly session cookie. One attempt, no retry — the retry
 * policy belongs to `openIncidentLink`, because only one of these failures is worth retrying.
 */
export async function exchangeLinkToken(token: string): Promise<LinkExchange> {
  try {
    const res = await apiPost<{ incident_id: string }>('/api/incident-link/session', { token })
    return res?.incident_id ? { ok: true, incidentId: res.incident_id } : { ok: false, reason: 'error' }
  } catch (e) {
    if (!(e instanceof ApiError)) return { ok: false, reason: 'error' }
    // status 0 is api.ts's "no connection / timed out / captive portal" — waiting for signal
    // is a different instruction than anything the server said.
    if (e.status === 0) return { ok: false, reason: 'offline' }
    if (e.status === 403) return { ok: false, reason: 'disabled' } // station has the feature off
    if (e.status === 401) return { ok: false, reason: 'invalid' }  // link invalid or expired
    if (e.status === 404) return { ok: false, reason: 'notReady' } // closed / archived / not ingested
    return { ok: false, reason: 'error' }
  }
}

// A 404 is the one failure that may fix itself while the responder is looking at the screen:
// the alert reaches the phone over the alerting system's own path, which can beat kp-front's
// ingest of the same Einsatz by a few seconds. So retry a handful of times behind a visible
// "noch nicht verfügbar" state before settling — but keep it short enough that a genuinely
// closed incident doesn't leave someone staring at a spinner in the rain.
export const LINK_NOT_READY_ATTEMPTS = 4
export const LINK_NOT_READY_DELAY_MS = 4_000

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Open a link: exchange, and re-exchange while the incident is merely not ingested YET.
 * `onPending` fires before each wait so the screen can name the state it's in (attempt 1 =
 * the first retry). Injectable `exchange`/`sleep` keep the policy testable.
 *
 * ⚠️ It touches NOTHING but the link cookie — no login is shed, none is created. An Atemschutz
 * link used to sign the browser out first, so that the handed-over board would win over a
 * session the phone's owner had of their own; that made the link a thing that reaches into the
 * device, which is exactly what it must not be. The precedence is now the page's to state
 * (lib/linkMode · linkPageOwnsSession), and it lasts only as long as the page.
 */
export async function openIncidentLink(
  token: string,
  opts: {
    onPending?: (attempt: number) => void
    exchange?: (token: string) => Promise<LinkExchange>
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<LinkExchange> {
  const exchange = opts.exchange ?? exchangeLinkToken
  const sleep = opts.sleep ?? wait
  let result = await exchange(token)
  for (
    let attempt = 1;
    attempt < LINK_NOT_READY_ATTEMPTS && !result.ok && result.reason === 'notReady';
    attempt += 1
  ) {
    opts.onPending?.(attempt)
    await sleep(LINK_NOT_READY_DELAY_MS)
    result = await exchange(token)
  }
  return result
}
