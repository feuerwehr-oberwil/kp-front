// Standing links (2026-09-09) — the exchange behind the two STATION-LEVEL credentials:
// `/l/t<secret>` enrolls the Stations-Terminal (then lives on its device cookie at /terminal),
// `/l/s<secret>` is the fixe Atemschutz-URL, the laminated QR on the Überwachungstafel.
//
// Unlike the per-incident links (lib/incidentLink), the URL names no Einsatz — the backend
// resolves «whichever is open» at exchange time and can answer three ways: bound to one
// («ok»), nothing running («idle»), or several running («choose», pick one). The page that
// shows these states re-exchanges on a timer, so the same call is the boot, the poll and the
// recovery after an Einsatz closes; passing the currently bound incident keeps a made choice
// sticking while that Einsatz runs (backend/app/api/incident_link · _resolve_standing).

import { ApiError, apiPost } from './api'

/** One row of a «choose» answer — what the chooser can show, nothing more. */
export interface StandingCandidate {
  id: string
  title: string
  address: string | null
  started_at: string | null
  is_exercise: boolean
}

export type StandingResolution =
  | { status: 'ok'; incidentId: string }
  | { status: 'idle' }
  | { status: 'choose'; candidates: StandingCandidate[] }

/**
 * Why the standing credential could not answer at all — holder-facing, not an HTTP status.
 * `invalid` covers the rotten cases together (wrong/rotated secret, dead device cookie): the
 * instruction is the same — this QR/PC needs re-enrolling from the Verwaltung. `disabled` is
 * the one 403 with an instruction of its own (the station switched the feature off).
 */
export type StandingFailure = 'invalid' | 'disabled' | 'offline' | 'error'

export type StandingExchange =
  | { ok: true; resolution: StandingResolution }
  | { ok: false; reason: StandingFailure }

interface WireAnswer {
  status?: 'ok' | 'idle' | 'choose'
  incident_id?: string
  candidates?: StandingCandidate[]
}

function parseAnswer(res: WireAnswer | null): StandingExchange {
  if (res?.status === 'ok' && res.incident_id) return { ok: true, resolution: { status: 'ok', incidentId: res.incident_id } }
  if (res?.status === 'idle') return { ok: true, resolution: { status: 'idle' } }
  if (res?.status === 'choose' && Array.isArray(res.candidates)) {
    return { ok: true, resolution: { status: 'choose', candidates: res.candidates } }
  }
  return { ok: false, reason: 'error' }
}

function parseFailure(e: unknown): StandingExchange {
  if (!(e instanceof ApiError)) return { ok: false, reason: 'error' }
  if (e.status === 0) return { ok: false, reason: 'offline' }
  if (e.status === 401) return { ok: false, reason: 'invalid' }
  if (e.status === 403) return { ok: false, reason: 'disabled' }
  return { ok: false, reason: 'error' }
}

/** Trade a standing token (`t…`/`s…`) for a session — the same door every link uses.
 *  `incidentId` is the pick from a «choose» answer, or the incident the page is already
 *  bound to. The terminal's FIRST exchange goes through here (it is the enrollment: the
 *  backend leaves the device cookie behind); every later one uses the cookie call below. */
export async function exchangeStandingToken(token: string, incidentId?: string | null): Promise<StandingExchange> {
  try {
    const body: Record<string, unknown> = { token }
    if (incidentId) body.incident_id = incidentId
    return parseAnswer(await apiPost<WireAnswer>('/api/incident-link/session', body))
  } catch (e) {
    return parseFailure(e)
  }
}

/** The enrolled terminal's poll: no token — the httpOnly device cookie is the credential, so
 *  the secret never exists anywhere the page could show. */
export async function exchangeTerminalSession(incidentId?: string | null): Promise<StandingExchange> {
  try {
    const body: Record<string, unknown> = {}
    if (incidentId) body.incident_id = incidentId
    return parseAnswer(await apiPost<WireAnswer>('/api/incident-link/terminal-session', body))
  } catch (e) {
    return parseFailure(e)
  }
}

/** How often a standing page re-asks «what is open?». It is the whole liveness story — the
 *  idle screen waking up on an alarm, the chooser updating, a closed Einsatz falling back to
 *  idle — so it stays short; the answerer is one indexed query on the station's own box, and
 *  the terminal is a mains-powered PC, not a phone battery. */
export const STANDING_POLL_MS = 10_000
