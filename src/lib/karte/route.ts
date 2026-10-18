// The «Karte & Objekte» address (docs/karte-objekte.md): `/karte`, deep-linkable, and
// `/karte?objekt=<id>` with an object selected. No router library — the same pushState + one event
// the Objektbesuche use (objectVisits/route · navigateTo / useLocationKey), so the app's counted
// history entries stay one mechanism.

import { useLocationKey } from '../../objectVisits/route'

export const KARTE_BASE = '/karte'

export const isKartePath = (pathname: string): boolean => pathname === KARTE_BASE || pathname.startsWith(`${KARTE_BASE}/`)

export interface KarteRoute {
  /** the object to select (`?objekt=`), or null */
  objekt: string | null
}

/** Read the route from a pathname + search. Null = not a Karte & Objekte address. */
export function parseKarteRoute(pathname: string, search: string): KarteRoute | null {
  if (!isKartePath(pathname)) return null
  const id = new URLSearchParams(search).get('objekt')?.trim()
  return { objekt: id || null }
}

export function karteHref(r: Partial<KarteRoute> = {}): string {
  return r.objekt ? `${KARTE_BASE}?${new URLSearchParams({ objekt: r.objekt })}` : KARTE_BASE
}

export function useKarteRoute(): KarteRoute | null {
  const key = useLocationKey()
  const i = key.indexOf('?')
  return parseKarteRoute(i < 0 ? key : key.slice(0, i), i < 0 ? '' : key.slice(i))
}
