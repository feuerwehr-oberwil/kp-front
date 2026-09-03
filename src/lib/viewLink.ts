// The Einsatz's shareable links — one door (`/l/<token>`), two kinds.
//
//   · `view`       — the whole Einsatz, read-only, no login: Karte, Pläne, Verlauf, Fotos,
//                    Zeiten. Handed to the Zentrale, the EL or a Nachbarwehr DURING the Einsatz
//                    and to der Gemeinde or a Nachbarwehr AFTER it — it is one and the same
//                    thing to the person sending it, so it is one link. It has a secret of its
//                    own on the incident row, so it needs no station key (it always works) and
//                    it SURVIVES the Abschluss, until it is revoked.
//   · `atemschutz` — one Einsatz, only the Atemschutzüberwachung, and it may be OPERATED: a
//                    non-FU scans the QR and runs the Tafel from their own phone. It DIES with
//                    the Einsatz — a closed incident answers 404, which the link app already
//                    renders as its «nicht bereit» state.
//
// ⚠️ There is a THIRD kind of `/l/<token>` on the wire that this module deliberately does not
// mint: the alerting gateway's JWT, signed with the station's `incident_link_key` and written
// into every alarm text (lib/alarmText · LINK_PREFIX). It is a WIRE CONTRACT — the backend keeps
// minting and exchanging it (`POST /api/incidents/<id>/einsatz-link`, `POST
// /api/incident-link/session`) — but no UI mints one by hand any more (03.09.): it dies at the
// Abschluss and needs a station key, so as a hand-over it was strictly worse than `view`, which
// says the same sentence and always works. Exchange lives in lib/incidentLink, untouched.
//
// The server returns only the token; the address is composed here from the browser's own origin,
// so nothing in the deployment has to be told what it is reachable under. Both land on the
// same `/l/<token>` path — the exchange decides what the session may do from the token itself.

import { appConfig } from '../config/appConfig'
import { apiDelete, apiGet, apiPost } from './api'

/** Which of the Einsatz's two links a call is about — both have a secret on the incident row,
 *  and are therefore both readable back and revocable. */
export type ShareLinkKind = 'view' | 'atemschutz'

/** «Teilen» — the two handovers, in the order somebody reaches for them, and in the shape the
 *  sheet's own chooser wants (components/panels/ShareIncident): a two-line label whose SECOND
 *  line is the distinction that matters at 3am — lesen ↔ bedienen.
 *
 *  A function, not a module constant: `appConfig.copy` is a getter and a capture at import time
 *  would freeze the language (see config/copy · getCopy).
 *
 *  `archived` drops a door rather than disabling it: the Atemschutz link DIES with the Abschluss
 *  (a closed incident answers 404), so afterwards it is not a choice, it is a dead end. The
 *  read-only link is the one that outlives the Einsatz — and precisely the one wanted days later
 *  — so a closed Einsatz is shared through that one alone, with no chooser to make. */
export function shareDoors(opts: { archived?: boolean } = {}): ShareDoorRow[] {
  const C = appConfig.copy.preflight
  const rows: ShareDoorRow[] = [
    { kind: 'view', label: C.shareKindFull, sub: C.shareKindFullSub, livesPastAbschluss: true },
    { kind: 'atemschutz', label: C.shareKindAtem, sub: C.shareKindAtemSub, livesPastAbschluss: false },
  ]
  return opts.archived ? rows.filter((r) => r.livesPastAbschluss) : rows
}

interface ShareDoorRow {
  kind: ShareLinkKind
  /** what the link shows */
  label: string
  /** …and what the holder may do with it — the half a glance actually needs */
  sub: string
  /** Does this link still work once the Einsatz is abgeschlossen? Only the read-only one does. */
  livesPastAbschluss: boolean
}

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
