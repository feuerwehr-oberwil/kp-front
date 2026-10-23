// Whether an Einsatz is running – the one client-side rule, in a leaf module: api/incidents
// re-exports it, and incidentClosed imports it from here (a value import from api/incidents
// closed a ring api/incidents → api/workspace → incidentClosed → api/incidents, sweep B.12).
import type { IncidentMeta } from './api/incidents'

/** `Incident.status` values that mean the Einsatz is RUNNING — mirrors the backend's
 *  `INCIDENT_ACTIVE_STATUSES`. "offen" is what every intake writes; "in_arbeit" is what an
 *  editor sets once somebody is working it (shown as «In Arbeit» in the Einsatz list). */
export const INCIDENT_ACTIVE_STATUSES = ['offen', 'in_arbeit']

/** Is this Einsatz still running? The client-side twin of the backend's `Incident.is_open`,
 *  and the one place to ask — a hand-written copy that drifts from the server's answer shows
 *  affordances the API then refuses (or hides ones it would allow).
 *
 *  `closed_at` is deliberately NOT consulted: it is the first Einsatzende as a TIMESTAMP, kept
 *  across a reopen so later rows read as Nachträge (see lib/reminders, lib/report). Treating it
 *  as a liveness flag left a reactivated Einsatz half-dead. `is_archived` is the state. */
export function isIncidentRunning(i: Pick<IncidentMeta, 'is_archived' | 'status'>): boolean {
  return !i.is_archived && INCIDENT_ACTIVE_STATUSES.includes(i.status)
}
