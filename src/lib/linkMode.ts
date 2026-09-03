// Which session THIS page is asking with — decided in one place and sent on every request
// (backend/app/auth/incident_link.py · LINK_MODE_HEADER reads it).
//
// An Einsatz-Link is the literal page and nothing more: opening one must not change what this
// device is logged in as, and the device's own login must not change what the link page shows.
// The link session rides a site-wide cookie — it has to, because `<img src="/api/media/…">`
// and the service worker cannot carry a header of ours — so until 02.09. the mere PRESENCE of
// that cookie decided what the whole browser was: the bare site answered as the link's viewer,
// a dead link cookie left the login screen behind a 403, and the handed-over Atemschutz board
// bought its own precedence by signing the phone OUT first. The page now says which it means.
//
// Derived from the URL at call time rather than from state set at boot: the deployment config
// is fetched before any React route exists, a link page keeps its `/l/<token>` address for its
// whole life (nothing rewrites the pathname), and there is nothing to initialise, to get wrong
// in the wrong order, or to leave stale after a reload.

/** The header itself. `use` = this page IS the link; `off` = the ordinary app; absent = a
 *  subresource the browser fetches without our headers, where the old rule still applies. */
const LINK_MODE_HEADER = 'X-Incident-Link'

// The alerting system mints a JWT offline, so the token is base64url segments joined by dots.
// Anything else in the path isn't a link we can exchange — say so without a round trip.
const LINK_PATH = /^\/l\/([A-Za-z0-9._-]{8,})\/?$/

/** The token in `/l/<token>`, or null when the path isn't a link URL at all. */
export function linkTokenFromPath(pathname: string): string | null {
  const m = LINK_PATH.exec(pathname)
  return m ? m[1] : null
}

/** Which kind of link a token is, by the marker the backend puts in front of the secret
 *  (api/incident_link · VIEW_TOKEN_PREFIX / ATEMSCHUTZ_TOKEN_PREFIX); a JWT has neither. */
export function linkKindFromToken(token: string): 'alarm' | 'view' | 'atemschutz' {
  if (token.startsWith('a')) return 'atemschutz'
  if (token.startsWith('v')) return 'view'
  return 'alarm'
}

const currentPath = (): string => (typeof location === 'undefined' ? '/' : location.pathname)

/**
 * Does this page's own link session outrank whatever login the device holds?
 *
 * True only for the ATEMSCHUTZ link: «Überwachung abgeben» means this phone becomes the
 * Überwachung, and the colleague at the Eingang may well be a member with a login of their
 * own — the board is still what that page must show. The alarm and view links keep the older
 * rule (a signed-in member who taps an alert link stays who they are), so they say nothing
 * and the server falls back to «only where there is no login».
 */
export function linkPageOwnsSession(pathname = currentPath()): boolean {
  const token = linkTokenFromPath(pathname)
  return !!token && linkKindFromToken(token) === 'atemschutz'
}

/** The header for one request, from the address bar. */
export function linkSessionHeaders(pathname = currentPath()): Record<string, string> {
  if (!linkTokenFromPath(pathname)) return { [LINK_MODE_HEADER]: 'off' }
  return linkPageOwnsSession(pathname) ? { [LINK_MODE_HEADER]: 'use' } : {}
}
