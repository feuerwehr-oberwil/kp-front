// «Karte & Objekte» — where the viewer starts and the station's object catalogue
// (docs/karte-objekte.md · «The viewer» and «Offline»).

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { onReachable } from '../../lib/connectivity'
import { deploymentDefaultCenter } from '../../lib/deploymentConfig'
import { loadStationObjects, type StationObject, type StationObjects } from '../../lib/api/stationReference'
import { coordOf } from '../../lib/karte/search'
import { loadKarteView } from '../../lib/karte/session'
import type { LngLat } from '../../types'
import { panelPad } from './useKarteCamera'

const COUNTRY_CENTER: LngLat = [8.2275, 46.8182]
const EMPTY_OBJECTS: StationObject[] = []

/** Where to start: the last view of this session, else the station. The surface reads it ONCE
 *  per mount (`useState(karteStart)`) — before the address starts following the selection. */
export function karteStart() {
  const v = loadKarteView()
  // the deep link (?objekt=) wins over where this session last was
  const linked = new URLSearchParams(window.location.search).get('objekt')
  const wanted = linked ?? v?.objectId ?? null
  // the Checkliste comes back with the session — unless a deep link asks for another object
  const library = v?.surface === 'checkliste' && (!linked || linked === v.objectId)
  return { view: v, wanted, library, center: v?.center ?? deploymentDefaultCenter() ?? COUNTRY_CENTER, zoom: v?.zoom ?? (deploymentDefaultCenter() ? 15.5 : 8) }
}

/** The catalogue, loaded once per mount. The object the start asks for is handed to `onRestore`
 *  (a stable callback: the surface selects it and reopens its document) and, for a deep link,
 *  framed beside the panel — `flyPending` runs that frame once the map has settled when the
 *  catalogue answered first. Shown from the device because the server could not be asked, the
 *  fresh one is taken as soon as it answers again (lib/connectivity · onReachable), without
 *  touching the selection. */
export function useKarteCatalogue(start: ReturnType<typeof karteStart>, mapRef: RefObject<MapRef | null>, phone: boolean, onRestore: (o: StationObject) => void) {
  // a frame asked for before the map exists (a deep link resolves faster than MapLibre loads)
  const pendingFly = useRef<LngLat | null>(null)
  // read by the (once-per-mount) deep-link frame, which must not re-run when the layout flips
  const phoneRef = useRef(phone)
  useEffect(() => { phoneRef.current = phone }, [phone])
  const flyPending = useCallback(() => {
    const map = mapRef.current
    if (!map || !pendingFly.current) return
    // the panel opens with it: the object in the strip above the phone's sheet / beside the panel
    map.jumpTo({ center: pendingFly.current, zoom: 17.6, padding: panelPad(phoneRef.current) })
    pendingFly.current = null
  }, [mapRef])

  const [cat, setCat] = useState<{ data: StationObjects | null; fromDevice: boolean; failed: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    loadStationObjects().then((r) => {
      if (!alive) return
      setCat({ data: r.value, fromDevice: r.source !== 'network', failed: false })
      const o = start.wanted ? r.value.objects.find((x) => x.id === start.wanted) : null
      if (!o) return
      onRestore(o)
      // a deep link frames its object; a restored session keeps the frame it had
      const at = coordOf(o)
      if (at && start.wanted !== start.view?.objectId) { pendingFly.current = at; flyPending() }
    }).catch(() => { if (alive) setCat({ data: null, fromDevice: false, failed: true }) })
    return () => { alive = false }
    // once per mount: the start view is read once, and the two callbacks are stable
  }, [start, flyPending, onRestore])
  const catStale = !!cat && (cat.fromDevice || cat.failed)
  useEffect(() => {
    if (!catStale) return
    const refresh = () => {
      loadStationObjects().then((r) => { if (r.source === 'network') setCat({ data: r.value, fromDevice: false, failed: false }) }).catch(() => {})
    }
    const offReach = onReachable(refresh)
    window.addEventListener('online', refresh)
    return () => { offReach(); window.removeEventListener('online', refresh) }
  }, [catStale])
  const objects = cat?.data?.objects ?? EMPTY_OBJECTS
  const byId = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects])
  return { cat, objects, byId, flyPending }
}
