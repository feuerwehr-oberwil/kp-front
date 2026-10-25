// «Karte & Objekte» — the buildings on the map (docs/karte-objekte.md · «Die Häuser»): the OSM
// outlines per cell, the survey's houses, and every station object's buildings.

import { useCallback, useMemo, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import type { StationObject } from '../../lib/api/stationReference'
import { cellOf, cellsFor, loadCell, OUTLINE_MIN_ZOOM, ringsAround, useHouses } from '../../lib/karte/outlines'
import { objectBuildings } from '../../lib/karte/places'
import { coordOf } from '../../lib/karte/search'
import type { ObjectOutlines } from '../../lib/karte/selection'
import type { LngLat } from '../../types'

/** `loadOutlines` asks the OSM cells of the view (from OUTLINE_MIN_ZOOM; each cell once) — the map
 *  calls it on every settled view. `ringsNear(at)` is what a building tap / hover matches: the
 *  survey's houses first, one per house, OSM where they have none (lib/karte/outlines ·
 *  ringsAround). `outlines` are each station object's buildings — the server's official set, else
 *  the survey house its point lies in, else the OSM outline (lib/karte/places · objectBuildings,
 *  the same `ringsNear` a tap uses). */
export function useObjectOutlines(mapRef: RefObject<MapRef | null>, objects: readonly StationObject[]) {
  const [cells, setCells] = useState<Record<string, LngLat[][]>>({})
  const loadOutlines = useCallback(() => {
    const map = mapRef.current
    if (!map || map.getZoom() < OUTLINE_MIN_ZOOM) return
    const b = map.getBounds()
    for (const key of cellsFor(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())) {
      void loadCell(key).then((rings) => setCells((c) => (c[key] ? c : { ...c, [key]: rings }))).catch(() => {})
    }
  }, [mapRef])
  const houses = useHouses()
  const ringsNear = useCallback((at: LngLat) => ringsAround(houses, cells[cellOf(at)], at), [houses, cells])
  const outlines = useMemo<ObjectOutlines>(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof objectBuildings>>>()
    for (const o of objects) {
      const at = coordOf(o)
      if (!at) continue
      const b = objectBuildings(o, ringsNear(at))
      if (b) m.set(o.id, b)
    }
    return m
  }, [objects, ringsNear])
  return { loadOutlines, ringsNear, outlines }
}
