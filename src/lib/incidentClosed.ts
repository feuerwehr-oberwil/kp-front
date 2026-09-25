import { ApiError } from './api'
import { isIncidentRunning, type IncidentMeta } from './api/incidents'

/**
 * «Dieser Einsatz ist auf einem anderen Gerät abgeschlossen worden» — how a device finds out,
 * and what the answer looks like on the wire (staging walk-through 25.09.2026, N3).
 *
 * One phone closed the Einsatz; the other phone and the tablet ran it live for minutes
 * afterwards. Their clocks ticked, their alarm engine wrote «Atemschutz-Alarm … Überfällig» and a
 * «Kontakt» tap wrote its row — all INTO the closed record. Closing does not move the workspace
 * revision, so nothing any device followed ever changed.
 *
 * Three ways the news arrives, all funnelled into `reportIncidentClosed`:
 *  - the workspace live poll: every answer, the 304 included, carries `X-Incident-Open`, and the
 *    server wakes the parked followers on a close (api/workspace · pollWorkspaceSince) — within
 *    a second on a visible device;
 *  - a refusal: once closed, the server answers a live write — an Atemschutz event, a «team»
 *    row, the Tafel in a workspace save — with 409 `{code: 'incident_closed'}`. Every outbox
 *    parks such a write as REFUSED (kept, exported with «Einträge sichern», never re-sent, not
 *    a red lamp) and reports it here: a device that was offline during the close learns it from
 *    its own first delivery;
 *  - the 30 s incident-list watch: the active Einsatz is missing from the open list. That is only
 *    a SUSPICION (a list is bounded, a cache is old), so App asks the server before acting.
 *
 * App owns the answer (App · onIncidentClosed): the same Einsatz, read-only, with a one-line
 * notice — never a jump into another Einsatz.
 */

/** The refusal's name — mirrors backend api/incidents · INCIDENT_CLOSED_CODE. */
export const INCIDENT_CLOSED_CODE = 'incident_closed'

/** Did the server refuse this write because the Einsatz is closed? A plain 409 on the workspace is
 *  the revision conflict (merge and retry); this one is final for as long as it stays closed. */
export function isIncidentClosedRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && e.code === INCIDENT_CLOSED_CODE
}

/** The first Einsatzende the refusal names, when it names one. */
export function refusalClosedAt(e: unknown): string | null {
  const at = e instanceof ApiError ? e.data?.closed_at : undefined
  return typeof at === 'string' ? at : null
}

export interface IncidentClosedSignal {
  incidentId: string
  /** the server's `closed_at` (first Einsatzende, kept across a reopen), when the signal had it */
  closedAt?: string | null
  /** `poll` and `refusal` are the server saying so; `list` is only an absence, to be checked */
  source: 'poll' | 'refusal' | 'list'
}

type Listener = (s: IncidentClosedSignal) => void
const listeners = new Set<Listener>()

/** Say that `incidentId` is (or may be) closed. Cheap and repeatable: App acts on the first. */
export function reportIncidentClosed(signal: IncidentClosedSignal): void {
  for (const l of [...listeners]) l(signal)
}

/** Subscribe; returns the unsubscribe. */
export function onIncidentClosed(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * WHEN the notice says the Einsatz was closed. `closed_at` is the first Einsatzende and is KEPT
 * across «Wieder öffnen» (so later rows read as Nachträge) — for an Einsatz reopened and closed
 * again it names the old close, hours before this device ever saw the Einsatz running. A
 * `closed_at` before the moment this device last saw it running therefore cannot be THIS close,
 * and the moment the device heard it is the honest answer instead.
 */
export function closedNoticeAt(closedAt: string | null | undefined, sawRunningAt: number, heardAt: number): number {
  const at = closedAt ? Date.parse(closedAt) : Number.NaN
  return Number.isFinite(at) && at >= sawRunningAt ? at : heardAt
}

/**
 * What App does with a signal: the meta to show the open Einsatz with from now on, or `null` for
 * «nothing» (App · onIncidentClosed). Pure, so the rules are pinned where they are written:
 *  - only the Einsatz ON SCREEN, and only while it still reads as running;
 *  - never the one THIS device is closing right now (its own poll hears it first);
 *  - the server's own meta wins when it could be read — and if it says «running» (reopened
 *    meanwhile, or the list was merely bounded) nothing happens;
 *  - without it, a signal the SERVER sent (poll header, refusal) stands on its own; the list's
 *    mere absence never does.
 */
export function closedMetaFor(
  current: IncidentMeta | null,
  signal: IncidentClosedSignal,
  fresh: IncidentMeta | null,
  closingLocally: string | null,
): IncidentMeta | null {
  if (!current || current.id !== signal.incidentId || !isIncidentRunning(current)) return null
  if (closingLocally === signal.incidentId) return null
  if (fresh) return isIncidentRunning(fresh) ? null : fresh
  if (signal.source === 'list') return null
  return { ...current, is_archived: true, closed_at: signal.closedAt ?? current.closed_at }
}
