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

/** Go to an address inside the app (or `/` to leave the surface). */
export function navigateTo(href: string, { replace = false } = {}): void {
  if (typeof window === 'undefined') return
  if (replace) window.history.replaceState(null, '', href)
  else window.history.pushState(null, '', href)
  window.dispatchEvent(new Event(EVENT))
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
