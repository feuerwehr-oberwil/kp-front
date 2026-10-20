// The Objektbesuche addresses (docs/object-visits.md · Device): `/besuche`, `/besuche/<id>`,
// `/besuche/neu?object=<source>:<id>|<uuid>&ref=<workRef>`, a visit at a PLACE as
// `/besuche/neu?lat=<lat>&lng=<lng>&label=<label>[&address=<address>]`, and a work list as
// `/besuche?liste=<ref>`. `&from=karte` on a launch (and the visit it opens) means «came from
// Karte & Objekte»: «Zurück» returns to `/karte` (KARTE_PATH), not to the Übersicht. No router library: pushState + one event, the way the rest of the app
// navigates without one. Offline, the service worker answers every one of these with the
// precached shell (vite.config · navigateFallback), so a deep link opens in a cellar too.

/*
 * **No history entry behind the operational screens** (05.10.2026, owner: iOS edge swipes «don't
 * always work as intended for modals»). iOS offers its standalone-app back swipe exactly when
 * there is an entry to go back to, and no CSS or event handler can switch it off — so the Karte,
 * the Plans and the launcher never have one. Sheets and modals do NOT push entries. The only
 * pushes are the Objektbesuche routes and the plan reader there, and the Checkliste library's
 * levels (lib/historyTrail – a device, its chapter: the native back steps up one, owner 20.10.2026),
 * all through `objectVisits/route` (`navigateTo` / `pushAppEntry`, counted in `history.state`), and
 * the way out is `leaveAppEntries`, which walks back over them rather than replacing the top entry
 * (which left one stale «/» behind the Karte per visit). Never call `history.pushState` directly.
 */

import { useSyncExternalStore } from 'react'
import { parsePlace, type PlaceQuery } from './place'

/** Where a launch came from — only the viewer says so today */
export type OvFrom = 'karte'

export type OvRoute =
  | { kind: 'overview' }
  | { kind: 'list'; ref: string }
  /** `edit`: open straight into «Bearbeiten» (`?bearbeiten=1`, from a sibling's card) */
  | { kind: 'visit'; id: string; edit?: boolean; from?: OvFrom }
  /** a finished visit's answers on a screen of their own (`/besuche/<id>/antworten`) */
  | { kind: 'answers'; id: string; from?: OvFrom }
  /** `checklist`: «Melden» from the Karte asks for one checklist up front (`?checkliste=<id>`,
   *  the station's «Fehlermeldung»); NewVisit falls back to its chooser when the catalogue has none */
  | { kind: 'new'; object: string; ref: string | null; from?: OvFrom; checklist?: string | null }
  /** a visit at a place with no catalogue object (contract C1); `after`: «Weitere Checkliste»
   *  from that visit (`&nach=<id>`) — its checklist is marked done in the chooser */
  | { kind: 'newPlace'; place: PlaceQuery; from?: OvFrom; after?: string; checklist?: string | null }

export const OV_BASE = '/besuche'
/** Karte & Objekte — where `from=karte` returns to */
export const KARTE_PATH = '/karte'
const EVENT = 'kp:ov-route'

const fromOf = (q: URLSearchParams): { from?: OvFrom } => (q.get('from') === 'karte' ? { from: 'karte' } : {})

export const isOvPath = (pathname: string): boolean => pathname === OV_BASE || pathname.startsWith(`${OV_BASE}/`)

/** Read a route from a pathname + search. Null = not an Objektbesuche address. */
export function parseOvRoute(pathname: string, search: string): OvRoute | null {
  if (!isOvPath(pathname)) return null
  const q = new URLSearchParams(search)
  const rest = pathname.slice(OV_BASE.length).replace(/^\/+|\/+$/g, '')
  if (!rest) {
    const ref = q.get('liste')
    return ref ? { kind: 'list', ref } : { kind: 'overview' }
  }
  if (rest === 'neu') {
    // an object wins; without one, a position makes it a visit at that place
    const checklist = q.get('checkliste')
    const asked = checklist ? { checklist } : {}
    const place = q.get('object') ? null : parsePlace(q)
    if (place) return { kind: 'newPlace', place, ...fromOf(q), ...(q.get('nach') ? { after: q.get('nach')! } : {}), ...asked }
    return { kind: 'new', object: q.get('object') ?? '', ref: q.get('ref') || null, ...fromOf(q), ...asked }
  }
  // a malformed escape (`/besuche/%E0`) is an unknown visit, never a thrown URIError at boot
  const [first, sub] = rest.split('/')
  let id = first
  try { id = decodeURIComponent(id) } catch { /* keep it as typed */ }
  if (sub === 'antworten') return { kind: 'answers', id, ...fromOf(q) }
  return q.get('bearbeiten') === '1' ? { kind: 'visit', id, edit: true, ...fromOf(q) } : { kind: 'visit', id, ...fromOf(q) }
}

export function ovHref(r: OvRoute): string {
  const withQuery = (path: string, q: URLSearchParams) => {
    if ('from' in r && r.from) q.set('from', r.from)
    const qs = q.toString()
    return qs ? `${path}?${qs}` : path
  }
  switch (r.kind) {
    case 'overview': return OV_BASE
    case 'list': return `${OV_BASE}?liste=${encodeURIComponent(r.ref)}`
    case 'visit': return withQuery(`${OV_BASE}/${encodeURIComponent(r.id)}`, new URLSearchParams(r.edit ? { bearbeiten: '1' } : {}))
    case 'answers': return withQuery(`${OV_BASE}/${encodeURIComponent(r.id)}/antworten`, new URLSearchParams())
    case 'new': {
      const q = new URLSearchParams({ object: r.object })
      if (r.ref) q.set('ref', r.ref)
      if (r.checklist) q.set('checkliste', r.checklist)
      return withQuery(`${OV_BASE}/neu`, q)
    }
    case 'newPlace': {
      const q = new URLSearchParams({ lat: String(r.place.lat), lng: String(r.place.lng), label: r.place.label })
      if (r.place.address) q.set('address', r.place.address)
      if (r.after) q.set('nach', r.after)
      if (r.checklist) q.set('checkliste', r.checklist)
      return withQuery(`${OV_BASE}/neu`, q)
    }
  }
}

/*
 * ⚠️ The app's own history entries are COUNTED (05.10.2026, owner: «can we prevent page swipes in
 * the pwa which don't always work as intended for modals etc»). iOS offers its edge-swipe back in
 * a standalone web app exactly when the page has an entry to go back to — and nothing a page can
 * do (no CSS, no `overscroll-behavior`, no preventDefault on the edge touch) switches the gesture
 * off. What DOES switch it off is having no entry behind the operational screens. Leaving the
 * Objektbesuche used to REPLACE its entry with «/», which left one same-address entry behind the
 * Karte per visit: the swipe slid in a stale snapshot over an open sheet and «went back» to the
 * same screen. So every push records how deep the app is (`history.state.kpDepth`, tied to THIS
 * page load by `kpDoc` — entries from before a reload belong to another document, and traversing
 * into one reloads the app), and `leaveAppEntries` walks back over exactly those instead.
 */
const DEPTH = 'kpDepth'
const DOC = 'kpDoc'
const docId = typeof window === 'undefined' ? '' : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** How many of THIS page's own pushes stand under the current entry (0 = the app's floor). */
export function appHistoryDepth(): number {
  if (typeof window === 'undefined') return 0
  const st = window.history.state as Record<string, unknown> | null
  const d = st?.[DEPTH]
  return st?.[DOC] === docId && typeof d === 'number' && d > 0 ? d : 0
}

/** Push a same-document entry, counted (see above). `extra` rides along in the state. */
export function pushAppEntry(href: string, extra?: Record<string, unknown>): void {
  window.history.pushState({ ...extra, [DOC]: docId, [DEPTH]: appHistoryDepth() + 1 }, '', href)
}

/** Go to an address inside the app (or `/` to leave the surface). */
export function navigateTo(href: string, { replace = false } = {}): void {
  if (typeof window === 'undefined') return
  if (replace) window.history.replaceState({ [DOC]: docId, [DEPTH]: appHistoryDepth() }, '', href)
  else pushAppEntry(href)
  window.dispatchEvent(new Event(EVENT))
}

/*
 * Walking back is ASYNC: `history.go(-n)` lands with a popstate, and until then `history.state`
 * still says the old depth — a second walk or a push computed meanwhile would go too far (below
 * the app's floor, out of the app in a browser tab). Every walk goes through `walkBack`; whoever
 * walks or pushes after one waits for `whenSettled`, and a surface's own popstate listener asks
 * `isWalkPop` whether a pop was a walk (someone leaving) or the user's back.
 */
let walking = 0
let lastWalkPop: Event | null = null
const onSettled: Array<() => void> = []

/** Walk back `n` of this page's entries; `landed` runs on arrival. Call it settled (whenSettled). */
export function walkBack(n: number, landed?: () => void): void {
  walking++
  const onPop = (e: Event) => {
    window.removeEventListener('popstate', onPop)
    walking--
    lastWalkPop = e
    landed?.()
    if (!walking) onSettled.splice(0).forEach((f) => f())
  }
  window.addEventListener('popstate', onPop)
  window.history.go(-n)
}

/** Run `f` now when no walk is under way, else once the last one has landed. */
export function whenSettled(f: () => void): void {
  if (walking) onSettled.push(f)
  else f()
}

/** Was this popstate a walk (`walkBack`), not the user's back gesture? Right in every listener of
 *  that event, registered before the walk began or after. */
export const isWalkPop = (e: Event): boolean => walking > 0 || e === lastWalkPop

/**
 * Leave every entry this page pushed and stand on `href` — the way OUT of a surface that was
 * entered with a push, so nothing is left behind the screen it returns to for a back swipe to
 * find. With nothing pushed (a deep link at start, a reload inside the surface) it replaces.
 * `then` runs once it stands there.
 */
export function leaveAppEntries(href: string, then?: () => void): void {
  if (typeof window === 'undefined') return
  whenSettled(() => {
    const d = appHistoryDepth()
    if (d === 0) { navigateTo(href, { replace: true }); then?.(); return }
    // the floor entry carries the address the surface was entered FROM, which is `href` in every
    // caller today — but say so explicitly once we are there. Its own query stays
    // (`/karte?objekt=…` is the object the viewer had open).
    walkBack(d, () => {
      const at = `${window.location.pathname}${window.location.search}`
      if (at !== href && !(href !== '/' && at.startsWith(`${href}?`))) navigateTo(href, { replace: true })
      then?.()
    })
  })
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener(EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(EVENT, cb)
  }
}

const snapshot = () => `${window.location.pathname}${window.location.search}`

/** The current address (pathname + search), re-rendering on every navigation. */
export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '/')
}

export function useOvRoute(): OvRoute | null {
  const key = useLocationKey()
  const i = key.indexOf('?')
  return parseOvRoute(i < 0 ? key : key.slice(0, i), i < 0 ? '' : key.slice(i))
}

/**
 * Does the Objektbesuche surface take the screen? Its route must be on, and it must have been
 * ENTERED (the launcher's button, a deep link at start) — or no Einsatz is open. A back gesture
 * that lands on an old /besuche entry must never put the surface over a running Einsatz.
 */
export function showsObjectVisits(s: { routeOn: boolean; entered: boolean; incidentOpen: boolean; linkSession: boolean }): boolean {
  if (!s.routeOn || s.linkSession) return false
  return s.entered || !s.incidentOpen
}
