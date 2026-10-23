// «Karte & Objekte» offline — the two probes the surface keeps running (docs/karte-objekte.md ·
// Offline). The decisions live in lib/karte/availability; these hooks only ask the device.
//
//   · `useObjectAvailability`: which of the selected object's plans open without a network (the
//     panel's ●/○, the rail's dimmed tiles, the surface's «Auf diesem Gerät» chip);
//   · `useMapCoverage`: which base tiles of the current view this device holds — the hatching
//     of map area with nothing behind it while offline, and the sheet's «Karte» row.

import { useEffect, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { storedPlanAlignments } from '../../lib/incidents'
import type { StationObject } from '../../lib/api/stationReference'
import {
  missingTiles, objectAvailability, openPlanProbe, openPlanTilesProbe, openTileProbe, planKey, planPdfUrl, viewTiles,
  type ObjectAvailability, type PlanHeld, type TileXY,
} from '../../lib/karte/availability'

/** What the device holds of these plan revisions' pages: the PDF and the tile pyramid (Cache
 *  Storage) — what the reader opens a sheet from (lib/karte/availability · planLamp). */
export async function heldPlanPages(plans: StationObject['plans']): Promise<Record<string, Omit<PlanHeld, 'meta'>>> {
  const [pdfProbe, tilesProbe] = await Promise.all([openPlanProbe(), openPlanTilesProbe()])
  const out: Record<string, Omit<PlanHeld, 'meta'>> = {}
  await Promise.all(plans.map(async (p) => {
    const [pdf, tiles] = await Promise.all([
      pdfProbe ? pdfProbe(planPdfUrl(p)) : Promise.resolve(false),
      tilesProbe ? tilesProbe(p) : Promise.resolve(null),
    ])
    out[planKey(p)] = { pdf, tiles }
  }))
  return out
}

/** …plus the alignment metadata (IndexedDB) the Gebäude and the aligned plan need. */
export async function heldPlans(plans: StationObject['plans']): Promise<Record<string, PlanHeld>> {
  const [pages, metas] = await Promise.all([
    heldPlanPages(plans),
    Promise.all(plans.map((p) => storedPlanAlignments(p.id, p.version).catch(() => null))),
  ])
  const out: Record<string, PlanHeld> = {}
  plans.forEach((p, i) => {
    const meta = metas[i]
    out[planKey(p)] = { ...pages[planKey(p)], meta: meta ? { floors: meta.floors?.length ?? 0 } : null }
  })
  return out
}

/** The selected object's availability; re-asked when `nonce` moves (a sheet just opened online
 *  lands in the cache a moment later). Null until the first answer. */
export function useObjectAvailability(obj: StationObject | null, nonce: number): ObjectAvailability | null {
  const [state, setState] = useState<{ id: string; sig: string; value: ObjectAvailability } | null>(null)
  const sig = obj ? obj.plans.map(planKey).join(',') : ''
  useEffect(() => {
    if (!obj) return
    let alive = true
    void heldPlans(obj.plans).then((held) => { if (alive) setState({ id: obj.id, sig, value: objectAvailability(obj, held) }) }).catch(() => {})
    return () => { alive = false }
    // the object's identity and its plan revisions are what is asked; the nonce re-asks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj?.id, sig, nonce])
  // keep the last answer for the same object while a re-ask runs (no lamp flicker)
  return obj && state && state.id === obj.id && state.sig === sig ? state.value : null
}

export type MapCoverage = { missing: TileXY[]; held: number; total: number } | 'far' | null

/**
 * The base tiles of the current view this device holds. Asked only while `enabled` (offline, or
 * the sheet is open), a moment after the map settles, never per frame. `templates` are the
 * VISIBLE base layer's tile URLs. Null = cannot tell (no service worker, no base layer).
 */
export function useMapCoverage({ enabled, mapRef, viewKey, templates, maxzoom }: {
  enabled: boolean
  mapRef: RefObject<MapRef | null>
  /** changes when the view does (centre + zoom, rounded) */
  viewKey: string
  templates: readonly string[] | null
  maxzoom?: number
}): MapCoverage {
  const [cov, setCov] = useState<{ key: string; value: MapCoverage } | null>(null)
  const tplKey = templates?.join('|') ?? ''
  const key = `${viewKey}|${tplKey}|${maxzoom ?? ''}`
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        const map = mapRef.current
        if (!map || !templates?.length) { if (alive) setCov({ key, value: null }); return }
        const b = map.getBounds()
        const tiles = viewTiles({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, map.getZoom(), maxzoom)
        if (!tiles) { if (alive) setCov({ key, value: 'far' }); return }
        const probe = await openTileProbe()
        if (!probe) { if (alive) setCov({ key, value: null }); return }
        const missing = await missingTiles(tiles, templates, probe)
        if (alive) setCov({ key, value: { missing, held: tiles.length - missing.length, total: tiles.length } })
      })().catch(() => { if (alive) setCov({ key, value: null }) })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
    // `key` carries the view and the templates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key])
  // a stale answer for another view is still the best picture until the new one arrives
  return enabled && cov ? cov.value : null
}
