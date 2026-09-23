import { isAtemschutzLinkKind, type AuthUser } from './auth'

/**
 * Which audit events a session may append — the client's mirror of the server's allowlist, so
 * an event the role can never write is never QUEUED (24.09.2026).
 *
 * ⚠️ The server is the protection (backend · api/events.py · `EL_EVENT_PREFIXES` and the
 * link check beside it); this is presentation of the same boundary, like `canEditRecord`. It
 * exists because the outbox cannot tell «refused» from «failed»: on 23.09.2026 the `el` phone
 * ran the Atemschutz alarm engine like every other device, emitted `atemschutz.alarm` five
 * times, got five 403s, and sat red for the rest of the Einsatz — «Erneut versuchen» re-sent
 * them into the same 403. The Verlauf row the same alarm writes is not affected: an `el` may
 * append journal rows, and those dedupe by their deterministic id.
 *
 * Keep the list in step with the backend — a prefix missing here silently stops a record the
 * role is allowed to write; a prefix too many here is the old red outbox again.
 */
export const EL_EVENT_PREFIXES = [
  'attendance.', 'checklist.', 'mittel.', 'report.', 'journal.', 'reminder.', 'weather.', 'shift.',
] as const

export type EventScope = (opType: string) => boolean

export const ALL_EVENTS: EventScope = () => true
export const NO_EVENTS: EventScope = () => false

/** The scope for a signed-in session. A viewer (and every read-only link) appends nothing; an
 *  Atemschutz-Link `atemschutz.*` only; the `el` role the record vocabulary; an editor all. */
export function eventScopeFor(user: Pick<AuthUser, 'role' | 'link_kind'> | null | undefined): EventScope {
  if (!user) return NO_EVENTS
  if (user.link_kind) return isAtemschutzLinkKind(user.link_kind) ? (op) => op.startsWith('atemschutz.') : NO_EVENTS
  if (user.role === 'editor') return ALL_EVENTS
  if (user.role === 'el') return (op) => EL_EVENT_PREFIXES.some((p) => op.startsWith(p))
  return NO_EVENTS
}

/** FNV-1a, 32 bit, as 8 hex digits — only to keep an over-long derived id under the column's
 *  128 characters while staying deterministic. Not a security hash. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const MAX_CLIENT_ID = 128 // backend · schemas.EventIn.client_id / models.IncidentEvent.client_id

/**
 * The `client_id` of an audit event that EVERY device observes rather than one hand performs
 * (24.09.2026) — the Atemschutz alarm and its end are the case. Built from the same identity
 * the Verlauf row already carries (`azal-…` / `azcl-…`), so the server's idempotency on
 * `client_id` collapses N devices into one row, exactly as it collapses N copies of the row.
 *
 * ⚠️ SCOPED TO THE ACTOR. The server keeps a `client_id` bound to its author (source + user);
 * the same id from another account, or from an Atemschutz-Link beside the FU tablet, is a
 * 409 by design. One account on three devices is ONE observer and gets one event; two
 * accounts each observed it and each get theirs — which is also the honest record.
 */
export function observedEventId(key: string, actor: string): string {
  const id = `obs-${key}@${actor}`
  return id.length <= MAX_CLIENT_ID ? id : `obs-${fnv1a(id)}-${id.slice(0, MAX_CLIENT_ID - 13)}`
}
