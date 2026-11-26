import { useLayoutEffect, useRef } from 'react'
import type { Marker } from 'maplibre-gl'
import type { LngLat } from '../types'

/** What a held marker is moved through: the MapLibre Marker behind a react-map-gl `<Marker ref>`. */
type Seatable = Pick<Marker, 'setLngLat'>

/**
 * A map marker held by the finger, moved through its own MapLibre Marker (`setLngLat`) instead of
 * through a store write and a render – the Karte's twin of the Plan chip drag's node translate
 * (components/useWbChipDrag).
 *
 * Usage (components/MapMarkers): every marker's `<Marker ref={refOf(id)}>`; each drag move calls
 * `hold(id, at)`; the release calls `release()` AFTER it has written `at` to the store.
 *
 * ⚠️ react-map-gl re-seats a Marker on its `longitude`/`latitude` props in every render. So while a
 * marker is held, a render mid-drag (the halo appearing, another device's edit of the same object)
 * would pull it back to its stored coordinate; the layout effect puts it under the finger again
 * before the frame paints – the hand wins until the release. The release writes where the Marker
 * stands, so the render after it agrees and nothing moves.
 */
export function useHeldMarker() {
  const markers = useRef(new Map<string, Seatable>())
  const held = useRef<{ id: string; at: LngLat } | null>(null)
  useLayoutEffect(() => {
    const h = held.current
    if (h) markers.current.get(h.id)?.setLngLat(h.at)
  })
  return {
    /** the ref callback for entity `id`'s Marker */
    refOf: (id: string) => (m: Seatable | null) => {
      if (m) markers.current.set(id, m)
      else markers.current.delete(id)
    },
    /** move `id`'s Marker to `at`, and keep it there over renders until `release` */
    hold: (id: string, at: LngLat) => {
      held.current = { id, at }
      markers.current.get(id)?.setLngLat(at)
    },
    /** hand the marker back to its props – after the release has written its coordinate */
    release: () => { held.current = null },
  }
}
