// «Unterirdische Bauten» on BOTH maps — «Karte & Objekte» and the Einsatz (owner, review round 5,
// 18.10.2026: «activate underground by default and also show it on the normal map (during an
// incident)»). ONE place says what the layer is, so the two maps cannot drift apart:
//
//   · the data: `useUnderground(on)` asks `lib/api/stationReference · loadUnderground` the first
//     time the layer is on (the device's IndexedDB copy offline), then keeps the rings for the
//     visit; a «none» is asked again the next time it goes on (the scheduler may have asked since);
//   · the look: `undergroundOverlay` — a dashed outline in the neutral ink (never an object's red
//     or a category colour), no fill, from street zoom (z16), not tappable (MapView and KarteApp
//     hit-test their own layers only);
//   · the Einsatz's Ebenen row: `undergroundLayerDef` — a real `LayerDef`, so the Einsatz's
//     device prefs, «Alle ein / aus», «Standard» and the replay's `layer.toggle` take it like any
//     row. ON by default (part of «Standard»). «Karte & Objekte» has its own row under «Station»
//     (KarteApp · UNDERGROUND_ROW), so `lib/karte/session · viewerLayers` leaves this one out.
//
// Not on the Tafel's «Lagekarte» box nor the Rapport's Kroki: both show the Lage (the box passes no
// prepared overlays, the print renders base map + Lage only) — a dashed garage is reference data.
// docs/karte-objekte.md · «Unterirdische Bauten».

import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { loadUnderground, outlineRings } from './api/stationReference'
import type { LayerDef, LayerId, LngLat, PreparedMapOverlay } from '../types'

/** the Einsatz's layer id (persisted in the device's layer prefs and the replay's events) */
export const UNDERGROUND_LAYER_ID = 'unterirdisch' as LayerId
/** drawn only from street zoom on — the region has ~1 000 of them */
export const UNDERGROUND_MIN_ZOOM = 16
/** the dash of a structure with no surface building, in line widths (an object's own garage too) */
export const UNDER_DASH = [2, 1.5]

/** The Einsatz's Ebenen row: on by default, in its own group named like the Karte's («Station»).
 *  Read at call time — the copy is the deployment's language. */
export function undergroundLayerDef(): LayerDef {
  const C = appConfig.copy.karte
  return { id: UNDERGROUND_LAYER_ID, group: C.layerGroupStation, label: C.layerUnderground, icon: 'footprint', visible: true }
}

/** The overlay for a set of rings — build it ONCE per set and ink (useMemo): MapLayers keeps the
 *  GeoJSON by the overlay's identity, so ~1 000 rings are not re-sent on every render. */
export function undergroundOverlay(rings: LngLat[][], ink: string, layer: LayerId, id = 'underground'): PreparedMapOverlay {
  return { id, kind: 'polygons', layer, rings, color: ink, fillOpacity: 0, lineWidth: 1.4, lineOpacity: 0.9, lineDasharray: UNDER_DASH, minzoom: UNDERGROUND_MIN_ZOOM }
}

export interface UndergroundState { state: 'loading' | 'ok' | 'none'; rings: LngLat[][] }

/** The set, asked the first time `on` is true and kept for as long as the caller lives. null =
 *  never asked. A session that may not read the station (an incident link) passes `on: false`. */
export function useUnderground(on: boolean): UndergroundState | null {
  const [under, setUnderState] = useState<UndergroundState | null>(null)
  // read synchronously by the effect: a second run before the answer (StrictMode) must not ask twice
  const cur = useRef<UndergroundState | null>(null)
  useEffect(() => {
    if (!on) return
    if (cur.current && cur.current.state !== 'none') return
    const set = (u: UndergroundState) => { cur.current = u; setUnderState(u) }
    set({ state: 'loading', rings: [] })
    loadUnderground()
      .then((s) => { const rings = outlineRings(s); set({ state: rings.length ? 'ok' : 'none', rings }) })
      .catch(() => set({ state: 'none', rings: [] }))
  }, [on])
  return under
}
