// «Karte & Objekte» — the markers' arrival (lib/karte/arrival; docs/karte-objekte.md).

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ARRIVAL_MAP_WAIT_MS, ARRIVAL_WINDOW_MS, arrivalDelays, waveDelay } from '../../lib/karte/arrival'
import type { StationObject } from '../../lib/api/stationReference'
import type { LngLat } from '../../types'
import s from './Karte.module.css'

/** The markers' wave, once, when the catalogue has answered AND the basemap stands (`setMapUp`
 *  on the first settled frame, or ARRIVAL_MAP_WAIT_MS — until then the markers are mounted but
 *  invisible, `mapUp` false → `.waiting`); the window closes ARRIVAL_WINDOW_MS later and every
 *  marker mounted after it (a tag replacing its dot on zoom, a re-selection) is instant.
 *  `arriveRef(id)` is each marker button's ref. */
export function useArrival(objects: readonly StationObject[], view: { center: LngLat; zoom: number }, rootRef: RefObject<HTMLDivElement | null>) {
  const [mapUp, setMapUp] = useState(false)
  useEffect(() => { const t = setTimeout(() => setMapUp(true), ARRIVAL_MAP_WAIT_MS); return () => clearTimeout(t) }, [])
  // when the wave began and each object's place in it; what an ELEMENT (dot or tag) makes of that
  // is decided once, on the element (arriveRef below)
  const [arrival, setArrival] = useState<{ start: number; places: Map<string, number> } | null>(null)
  const arrived = useRef(false)
  // a layout effect: the wave must be on the markers in the same paint that shows them
  useLayoutEffect(() => {
    if (arrived.current || !objects.length || !mapUp) return
    arrived.current = true
    setArrival({ start: performance.now(), places: arrivalDelays(objects, view, rootRef.current?.clientWidth || window.innerWidth) })
  }, [objects, view, mapUp, rootRef])
  useEffect(() => {
    if (!arrival) return
    const t = setTimeout(() => setArrival(null), ARRIVAL_WINDOW_MS)
    return () => clearTimeout(t)
  }, [arrival])
  // A marker's entrance, decided ONCE on the element (ref callback: in the commit, before its first
  // paint) — a changed animation-delay restarts a finished CSS animation, and the clock is not a
  // thing to read in render. A tag that replaces its dot is a NEW element and joins where the wave
  // stands (lib/karte/arrival · waveDelay): at once if the dot had already arrived. The class and
  // the variable are not React's, so a later className change leaves the finished entrance alone.
  const arriveRef = (id: string) => (el: HTMLButtonElement | null) => {
    if (!el || el.dataset.arrived || !arrival) return
    const place = arrival.places.get(id)
    if (place == null) return
    el.dataset.arrived = '1'
    const wave = waveDelay(place, performance.now() - arrival.start)
    if (wave == null) return
    el.style.setProperty('--arrive', `${wave}ms`)
    el.classList.add(s.arrive)
  }
  return { mapUp, setMapUp, arriveRef }
}
