// The Einsatz's shareable links — one door (`/l/<token>`), two kinds.
//
//   · `view`       — one Einsatz, read-only, no login: handed to somebody OUTSIDE the station so
//                    they can see in one go what was done (a Gemeinde, a Nachbarwehr, an
//                    insurer). It SURVIVES the Einsatz being closed, because that is the normal
//                    case for it, and it is revoked on its own.
//   · `atemschutz` — one Einsatz, only the Atemschutzüberwachung, and it may be OPERATED: a
//                    non-FU scans the QR and runs the Tafel from their own phone. It DIES with
//                    the Einsatz — a closed incident answers 404, which the link app already
//                    renders as its «nicht bereit» state.
//
// Neither is the alarm link a responder taps (auth/incident_link on the server carries all
// three, and the differences); that one is revoked by rotating the station's key.
//
// The server returns only the token; the address is composed here from the browser's own origin,
// so nothing in the deployment has to be told what it is reachable under. Both kinds land on the
// same `/l/<token>` path — the exchange decides what the session may do from the token itself.

import { apiDelete, apiGet, apiPost } from './api'

/** Which of the Einsatz's two shareable links a call is about. */
export type ShareLinkKind = 'view' | 'atemschutz'

export interface ShareLink {
  enabled: boolean
  /** the `/l/<token>` path segment; null whenever `enabled` is false */
  token: string | null
}

/** The one endpoint each kind lives on. Same shape, same verbs, editor-gated alike. */
const ENDPOINT: Record<ShareLinkKind, string> = {
  view: 'view-link',
  atemschutz: 'atemschutz-link',
}

const linkUrl = (incidentId: string, kind: ShareLinkKind) =>
  `/api/incidents/${incidentId}/${ENDPOINT[kind]}`

/** The full address to hand over. Empty string when there is no link — callers render the
 *  «noch keiner» state off `enabled`, never off a half-built URL. Both kinds share the door,
 *  so this stays one function. */
export function viewLinkUrl(link: ShareLink, origin = window.location.origin): string {
  return link.token ? `${origin}/l/${link.token}` : ''
}

/** What the sheet shows on open, for the selected kind. Editor-gated on the server. */
export function fetchShareLink(incidentId: string, kind: ShareLinkKind): Promise<ShareLink> {
  return apiGet<ShareLink>(linkUrl(incidentId, kind))
}

/** Mint it — or hand back the one that already exists. Idempotent on purpose: «where was that
 *  link again» must not be the same gesture as «kill the old one». */
export function createShareLink(incidentId: string, kind: ShareLinkKind): Promise<ShareLink> {
  return apiPost<ShareLink>(linkUrl(incidentId, kind), {})
}

/** Revoke it. The URL stops working, and so does every session already open on it. */
export function revokeShareLink(incidentId: string, kind: ShareLinkKind): Promise<ShareLink> {
  return apiDelete<ShareLink>(linkUrl(incidentId, kind))
}
