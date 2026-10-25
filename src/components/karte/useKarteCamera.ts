// «Karte & Objekte» — the camera around a selection (docs/karte-objekte.md · «The viewer»: «Closing
// a selection gives the camera back», «Back from a plan»; the rules are lib/karte/camera, these
// hooks only move the map):
//
//   · `useKarteCamera`: frames a selected place beside the tablet's panel / above the phone's
//     sheet, and gives the camera back when the selection closes;
//   · `useFrameOnReturn`: back on the map from a plan, the object stands in the free map again;
//   · `useCompassViews`: the compass menu — no saved views here (they are an Einsatz's).

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { deploymentDefaultCenter } from '../../lib/deploymentConfig'
import { besidePanel, cameraOnClose, returnOnSelect, type Camera, type CameraReturn, type Padding } from '../../lib/karte/camera'
import { coordOf } from '../../lib/karte/search'
import type { Sel } from '../../lib/karte/selection'
import type { StationObject } from '../../lib/api/stationReference'
import type { LngLat } from '../../types'
import type { ViewsApi } from '../MapViewsMenu'

/** how much of a phone's height the object sheet may cover (Ebenen's cap, 15-mobile · .layers-card):
 *  a place framed for it stands in the strip above */
const SHEET_SHARE = 0.72
const NOOP = () => {}
/** a rail's published width (lib/useRail: `--rail-w`, `--vrail-w` on <html>), its token's 60px when none is */
const railPx = (name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 60
/** The camera padding that frames a place beside the panel: on a phone the strip above the sheet
 *  (Ebenen's, up to ~72 % of the height), on a tablet the free map between the panel and the
 *  tool rail (lib/karte/camera · besidePanel) */
export const panelPad = (phone: boolean): Padding => (phone
  ? { top: 80, bottom: window.innerHeight * SHEET_SHARE, left: 0, right: 0 }
  : besidePanel(railPx('--rail-w'), railPx('--vrail-w')))

/** Selecting and closing, for the surface's select/deselect actions. Closing gives the camera back
 *  (owner, review round 4 — lib/karte/camera): the camera before the selection is kept here, the
 *  first selection's while one stays open, and dropped the moment the user moves the map
 *  themselves (`watchUserMoves`: a `movestart` fired with an originalEvent). */
export function useKarteCamera(mapRef: RefObject<MapRef | null>, phone: boolean, zoom: number) {
  const camBack = useRef<CameraReturn | null>(null)
  const cameraNow = (): Camera | null => {
    const map = mapRef.current
    if (!map || typeof map.getPadding !== 'function') return null
    const c = map.getCenter()
    const p = map.getPadding()
    return { center: [c.lng, c.lat], zoom: map.getZoom(), padding: { top: p.top ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0, right: p.right ?? 0 } }
  }
  /** a place is about to be selected (`how`: a tap / a search pick): keep the way back */
  const noteSelect = (how: 'tap' | 'search' = 'tap') => {
    const now = cameraNow()
    if (now) camBack.current = returnOnSelect(camBack.current, now, how)
  }
  const giveCameraBack = () => {
    const r = camBack.current
    camBack.current = null
    const now = cameraNow()
    const to = now && cameraOnClose(r, now)
    if (to) mapRef.current?.easeTo({ center: to.center, zoom: to.zoom, padding: to.padding, duration: 350 })
  }
  // added once, when the map has settled
  const watchingMoves = useRef(false)
  const watchUserMoves = useCallback(() => {
    const map = mapRef.current?.getMap?.()
    if (!map || watchingMoves.current) return
    watchingMoves.current = true
    map.on('movestart', (e) => { if ((e as { originalEvent?: unknown }).originalEvent) camBack.current = null })
  }, [mapRef])
  const flyTo = (at: LngLat, z = 17.6) => mapRef.current?.easeTo({ center: at, zoom: Math.max(zoom, z), padding: panelPad(phone), duration: 700 })
  /** keep the tapped place visible beside / above the panel, without changing the zoom */
  const reveal = (at: LngLat) => {
    const map = mapRef.current
    if (!map) return
    const p = map.project(at)
    const hidden = phone ? p.y > window.innerHeight * (1 - SHEET_SHARE) - 16 || p.y < 90 : p.x < panelPad(false).left
    if (hidden) map.easeTo({ center: at, padding: panelPad(phone), duration: 500 })
  }
  return { noteSelect, giveCameraBack, watchUserMoves, flyTo, reveal }
}

/** Back on the map from a plan, the object stands in the free map's middle again (owner, review
 *  round 6: «sometimes the object isn't neatly in focus like it should be») — a tap selects in
 *  place (`reveal`), so the object was wherever it was tapped, maybe at the bottom right. At the
 *  zoom the map had; the way back for ✕ stays (an ease carries no `originalEvent`). Not when the
 *  way back was a pick of another object, which frames itself (`sel` compares by identity). */
export function useFrameOnReturn(mapRef: RefObject<MapRef | null>, p: { openDoc: { doc: { id: string } } | null; sel: Sel | null; at: LngLat | null; panelShown: boolean; phone: boolean }) {
  const { openDoc, sel, at, panelShown, phone } = p
  const docWas = useRef<{ doc: string; sel: Sel | null } | null>(null)
  useEffect(() => {
    const was = docWas.current
    docWas.current = openDoc ? { doc: openDoc.doc.id, sel } : null
    if (!was || openDoc || !panelShown || was.sel !== sel) return
    if (at) mapRef.current?.easeTo({ center: at, padding: panelPad(phone), duration: 500 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per way back from a document
  }, [openDoc])
}

/** The compass menu's handlers: north up, the whole village, where I stand. */
export function useCompassViews(mapRef: RefObject<MapRef | null>, objects: readonly StationObject[], view: { center: LngLat; zoom: number; bearing: number }, holdHint: string): ViewsApi {
  const fitAll = () => {
    const pts = objects.map(coordOf).filter((c): c is LngLat => !!c)
    if (pts.length < 2) { mapRef.current?.easeTo({ center: deploymentDefaultCenter() ?? view.center, zoom: 15 }); return }
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
    mapRef.current?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 64, duration: 600 })
  }
  /** one GPS fix, then zoom (≥ 17) onto it; `orElse` when there is no position */
  const locate = (orElse?: () => void) => {
    if (!navigator.geolocation) { orElse?.(); return }
    navigator.geolocation.getCurrentPosition((p) => mapRef.current?.easeTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(view.zoom, 17) }), () => orElse?.(), { enableHighAccuracy: true, timeout: 10_000 })
  }
  return {
    list: [], current: view, onGo: NOOP, onSave: NOOP, onRename: NOOP, onDelete: NOOP,
    onResetNorth: () => mapRef.current?.easeTo({ bearing: 0 }),
    onFit: fitAll,
    onLocate: () => locate(),
    // holding the compass goes to where I stand – more often wanted than the whole village (owner,
    // Karte Haus round 2); no position (denied, timed out, no GPS) fits the village as before
    hold: { run: () => locate(fitAll), hint: holdHint },
  }
}
