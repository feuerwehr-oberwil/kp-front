// The Objektbesuche addresses (docs/object-visits.md · Device): `/besuche`, `/besuche/<id>`,
// `/besuche/neu?object=<source>:<id>|<uuid>&ref=<workRef>`, and a work list as
// `/besuche?liste=<ref>`. No router library: pushState + one event, the way the rest of the app
// navigates without one. Offline, the service worker answers every one of these with the
// precached shell (vite.config · navigateFallback), so a deep link opens in a cellar too.

import { useSyncExternalStore } from 'react'

export type OvRoute =
  | { kind: 'overview' }
  | { kind: 'list'; ref: string }
  | { kind: 'visit'; id: string }
  | { kind: 'new'; object: string; ref: string | null }

export const OV_BASE = '/besuche'
const EVENT = 'kp:ov-route'

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
  if (rest === 'neu') return { kind: 'new', object: q.get('object') ?? '', ref: q.get('ref') || null }
  // a malformed escape (`/besuche/%E0`) is an unknown visit, never a thrown URIError at boot
  let id = rest.split('/')[0]
  try { id = decodeURIComponent(id) } catch { /* keep it as typed */ }
  return { kind: 'visit', id }
}

export function ovHref(r: OvRoute): string {
  switch (r.kind) {
    case 'overview': return OV_BASE
    case 'list': return `${OV_BASE}?liste=${encodeURIComponent(r.ref)}`
    case 'visit': return `${OV_BASE}/${encodeURIComponent(r.id)}`
    case 'new': {
      const q = new URLSearchParams({ object: r.object })
      if (r.ref) q.set('ref', r.ref)
      return `${OV_BASE}/neu?${q.toString()}`
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

/**
 * Leave every entry this page pushed and stand on `href` — the way OUT of a surface that was
 * entered with a push, so nothing is left behind the screen it returns to for a back swipe to
 * find. With nothing pushed (a deep link at start, a reload inside the surface) it replaces.
 */
export function leaveAppEntries(href: string): void {
  if (typeof window === 'undefined') return
  const d = appHistoryDepth()
  if (d === 0) { navigateTo(href, { replace: true }); return }
  // the traversal is async; the floor entry carries the address the surface was entered FROM,
  // which is `href` in every caller today — but say so explicitly once we are there
  const onPop = () => {
    window.removeEventListener('popstate', onPop)
    if (`${window.location.pathname}${window.location.search}` !== href) navigateTo(href, { replace: true })
  }
  window.addEventListener('popstate', onPop)
  window.history.go(-d)
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
