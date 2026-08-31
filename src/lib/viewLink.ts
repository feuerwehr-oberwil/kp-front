// The Rapport's view-only Einsatz-Link.
//
// One Einsatz, read-only, no login — handed to somebody OUTSIDE the station so they can see in
// one go what was done: a Gemeinde, a Nachbarwehr, an insurer. It is deliberately NOT the alarm
// link a responder taps (auth/incident_link on the server carries both, and the differences):
// this one survives the Einsatz being closed, because that is the normal case for it, and it is
// revoked on its own instead of by rotating the station's key.
//
// The server returns only the token; the address is composed here from the browser's own origin,
// so nothing in the deployment has to be told what it is reachable under.

import { apiDelete, apiGet, apiPost } from './api'

export interface ViewLink {
  enabled: boolean
  /** the `/l/<token>` path segment; null whenever `enabled` is false */
  token: string | null
}

/** The full address to hand over. Empty string when there is no link — callers render the
 *  «noch keiner» state off `enabled`, never off a half-built URL. */
export function viewLinkUrl(link: ViewLink, origin = window.location.origin): string {
  return link.token ? `${origin}/l/${link.token}` : ''
}

/** What the Rapport shows on open. Editor-gated on the server. */
export function fetchViewLink(incidentId: string): Promise<ViewLink> {
  return apiGet<ViewLink>(`/api/incidents/${incidentId}/view-link`)
}

/** Mint it — or hand back the one that already exists. Idempotent on purpose: «where was that
 *  link again» must not be the same gesture as «kill the old one». */
export function createViewLink(incidentId: string): Promise<ViewLink> {
  return apiPost<ViewLink>(`/api/incidents/${incidentId}/view-link`, {})
}

/** Revoke it. The URL stops working, and so does every session already open on it. */
export function revokeViewLink(incidentId: string): Promise<ViewLink> {
  return apiDelete<ViewLink>(`/api/incidents/${incidentId}/view-link`)
}
