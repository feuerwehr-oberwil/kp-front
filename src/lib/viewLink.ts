// The Einsatz's shareable links — one door (`/l/<token>`), three kinds.
//
//   · `view`       — one Einsatz, read-only, no login: handed to somebody OUTSIDE the station so
//                    they can see in one go what was done (a Gemeinde, a Nachbarwehr, an
//                    insurer). It SURVIVES the Einsatz being closed, because that is the normal
//                    case for it, and it is revoked on its own.
//   · `atemschutz` — one Einsatz, only the Atemschutzüberwachung, and it may be OPERATED: a
//                    non-FU scans the QR and runs the Tafel from their own phone. It DIES with
//                    the Einsatz — a closed incident answers 404, which the link app already
//                    renders as its «nicht bereit» state.
//   · `einsatz`    — the ALARM link, minted here instead of by the alerting system (02.09.):
//                    a live read-only view handed to the Zentrale, the EL or a Nachbarwehr
//                    mid-Einsatz. It dies when the Einsatz is closed or the station rotates its
//                    key, so it has no state of its own — hence `mintEinsatzLink` below and no
//                    fetch/revoke pair.
//
// The server returns only the token; the address is composed here from the browser's own origin,
// so nothing in the deployment has to be told what it is reachable under. All three land on the
// same `/l/<token>` path — the exchange decides what the session may do from the token itself.

import { appConfig } from '../config/appConfig'
import { apiDelete, apiGet, apiPost } from './api'

/** Which of the Einsatz's two STORED links a call is about — the two with a secret on the
 *  incident row, and therefore the two that can be read back and revoked. */
export type ShareLinkKind = 'view' | 'atemschutz'

/** One of the three handovers «Teilen» offers. The Einsatz-Link is its own sheet rather than a
 *  third segment beside the other two: it has nothing to revoke and nothing to choose, so it
 *  would be a segmented option answering a different question from its neighbours. */
export type ShareDoor = ShareLinkKind | 'einsatz'

/** What the workspace currently has open: one of the three, or `'menu'` — the chooser itself,
 *  for the doors that cannot show a dropdown (the phone, where the Einsatzkopf's Teilen button
 *  does not fit, and the Einsatz-Karte's own «Teilen»). `null` is closed. */
export type ShareSheet = ShareDoor | 'menu'

/** «Teilen» — the three handovers, in the order somebody reaches for them: the running Einsatz
 *  first, because that is the one wanted with a Schadenplatz underfoot; the Rapport last, because
 *  it is the one wanted days later at a desk.
 *
 *  ONE list, two containers — the Einsatzkopf's dropdown (components/TopBar · TeilenMenu) and the
 *  `TeilenSheet` the phone and the Einsatz-Karte open (components/panels/ShareIncident). It lives
 *  here rather than beside either of them so neither can grow a fourth row the other doesn't have.
 *  A function, not a module constant: `appConfig.copy` is a getter and a capture at import time
 *  would freeze the language (see config/copy · getCopy).
 *
 *  ⚠️ The second line answers BOTH 3am questions — wem gebe ich das, und wie lange gilt es. The
 *  first and third row are otherwise the same sentence («ganzer Einsatz, nur lesen»), and which
 *  one somebody wants is decided entirely by whether the Einsatz is still running.
 *
 *  Which is also why `archived` drops rows rather than disabling them: two of the three links DIE
 *  with the Abschluss — the backend refuses to mint an Einsatz-Link on a closed Einsatz (409) and
 *  an Atemschutz link to one answers 404 — so after it they are not choices, they are dead ends.
 *  The Rapport-Link is the one that outlives the Einsatz, and it is precisely the one wanted days
 *  later, so the menu stays open on exactly that row. */
export function teilenRows(opts: { archived?: boolean } = {}): TeilenRow[] {
  const C = appConfig.copy.topBar
  const rows: TeilenRow[] = [
    { door: 'einsatz', icon: 'eye', label: C.shareEinsatz, sub: C.shareEinsatzSub, livesPastAbschluss: false },
    { door: 'atemschutz', icon: 'gauge', label: C.shareAtemschutz, sub: C.shareAtemschutzSub, livesPastAbschluss: false },
    { door: 'view', icon: 'doc', label: C.shareRapport, sub: C.shareRapportSub, livesPastAbschluss: true },
  ]
  return opts.archived ? rows.filter((r) => r.livesPastAbschluss) : rows
}

interface TeilenRow {
  door: ShareDoor
  icon: string
  label: string
  sub: string
  /** Does this link still work once the Einsatz is abgeschlossen? Only the Rapport's does. */
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

/** The read-only Einsatz-Link, minted with the station's own key (the one the Alarmierung uses).
 *
 *  Derived rather than stored, so asking twice hands back the address already circulating and
 *  there is nothing to fetch or revoke: it ends when the Einsatz is closed, or when the station
 *  rotates the key in der Verwaltung. Two refusals worth telling apart at the call site — 403 is
 *  «kein Link-Schlüssel eingerichtet», which nobody can fix on the Schadenplatz, and 409 is a
 *  finished Einsatz. */
export function mintEinsatzLink(incidentId: string): Promise<ShareLink> {
  return apiPost<ShareLink>(`/api/incidents/${incidentId}/einsatz-link`, {})
}
