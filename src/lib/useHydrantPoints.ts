import { useEffect, useState } from 'react'
import { apiGet } from './api'
import { hydrantPoints, type HydrantPoint } from './lageGrundgeruest'

// The station's hydrants as points, for the Lage-Grundgerüst's «nächster Hydrant» — read from the
// SAME reference layer the Ebenen panel draws (station data, `admin_geodata`), through the same
// URLs: the region-wide file online, the incident-box crop the offline download warmed into the
// service worker (`reference-data`, StaleWhileRevalidate) otherwise. Nothing new is cached and
// nothing is fetched until the card actually wants a hydrant.

/** One answer per URL for the life of the page — a reference layer changes with an admin push,
 *  not while an Einsatz is being worked. */
const cache = new Map<string, Promise<HydrantPoint[]>>()

function load(url: string): Promise<HydrantPoint[]> {
  let p = cache.get(url)
  if (!p) {
    p = apiGet<unknown>(url).then(hydrantPoints)
    // a failed fetch is not an answer — the next render may be online again
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

/**
 * The hydrant points, or null while unknown / unavailable. `urls` are tried in order (the one
 * the map is drawing first, then the other), so an offline device that never fired `offline`
 * still lands on the crop it has cached.
 */
export function useHydrantPoints(urls: readonly string[] | null, enabled: boolean): HydrantPoint[] | null {
  const key = enabled && urls?.length ? urls.join('\n') : ''
  const [got, setGot] = useState<{ key: string; points: HydrantPoint[] } | null>(null)
  useEffect(() => {
    if (!key) return
    let alive = true
    const list = key.split('\n')
    void (async () => {
      for (const url of list) {
        try {
          const points = await load(url)
          if (alive) setGot({ key, points })
          return
        } catch { /* try the next address */ }
      }
    })()
    return () => { alive = false }
  }, [key])
  return got && got.key === key ? got.points : null
}
