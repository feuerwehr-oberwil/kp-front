import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Entity, LayerId, LngLat } from '../types'
import { buzz } from '../lib/haptics'
import { effectiveLayer } from '../lib/mapView'
import { isMagnetEntity, MAGNET_DWELL_MS, MAGNET_RADIUS_PX } from '../lib/lineAttachments'

export interface PlaceMagnetDeps {
  mapInst: RefObject<MlMap | null>
  entities: Entity[]
  isVisible: (id: LayerId) => boolean
  /** a two-point shape (Rotation) is armed — MapView's `placeMagnet` prop */
  enabled: boolean
}

/**
 * ── Rotation legen: der Magnet an jedem der beiden Punkte ──
 *
 * A Rotation is laid between two PLACES, so each of its two taps may couple to a symbol — and
 * it couples the way everything else in the app does: press, hold until the ring closes, let go.
 *
 * ⚠️ Deliberately NOT the line-START exception (lib/useDraftMagnet · start),
 * which arms instantly because the finger was already ON the prong it aimed at. Here the very
 * same press is also the thing that PLACES a point, so an instant claim would silently attach
 * every point ever dropped near a symbol — the invisible coupling the ring exists to prevent.
 *
 * It rides the pointer, not the hover: a mouse crossing a symbol with no button down must not
 * start filling a ring for a tap that is not happening. MapView feeds it the pointer phases
 * (`down` / `move` / `up`, `cancel` when a pan begins) and asks `placedCoord` where a tap lands.
 */
export function usePlaceMagnet({ mapInst, entities, isVisible, enabled }: PlaceMagnetDeps) {
  const [placeMag, setPlaceMag] = useState<{ coord: LngLat; since: number; armed: boolean } | null>(null)
  const placeMagRef = useRef<{ key: string; coord: LngLat; since: number; armed: boolean } | null>(null)
  const placeDwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const placeDown = useRef(false)
  /** dragPan paused while a claim is live: a finger holding still for the MAGNET_DWELL_MS dwell wobbles
   *  past MapLibre's 3 px slop, and the pan that started killed the claim AND ate the click —
   *  on a real device the ring could never be ridden to the end. Paused, the full 32 px magnet
   *  radius is the wobble budget; leaving it clears the claim and gives the pan back. */
  const placePanPaused = useRef(false)
  // stable (refs + a state setter only), so the effect below still runs on `enabled` alone
  const clearPlaceMagnet = useCallback(() => {
    if (placeDwellTimer.current) { clearTimeout(placeDwellTimer.current); placeDwellTimer.current = null }
    if (placeMagRef.current) { placeMagRef.current = null; setPlaceMag(null) }
    if (placePanPaused.current) { placePanPaused.current = false; mapInst.current?.dragPan.enable() }
  }, [mapInst])
  // The prop can drop mid-claim (Escape, the dock's ×) — at that point every handler that could
  // clear the ring is unbound, so without this the ring and its pending dwell timer outlive the
  // gesture until the next pan. Unmount takes the timer with it for the same reason.
  useEffect(() => {
    if (!enabled) clearPlaceMagnet()
  }, [enabled, clearPlaceMagnet])
  useEffect(() => () => { if (placeDwellTimer.current) clearTimeout(placeDwellTimer.current) }, [])
  const trackPlaceMagnet = (at: LngLat) => {
    const map = mapInst.current
    if (!map) return
    const p = map.project(at)
    let best: { key: string; coord: LngLat; d: number } | null = null
    // a symbol you can see on this surface is a place you can aim the next one at
    const anchors: { key: string; coord: LngLat }[] = [
      ...entities.flatMap((e) => (isMagnetEntity(e) && Array.isArray(e.coord) && isVisible(effectiveLayer(e))
        ? [{ key: e.id, coord: e.coord as LngLat }] : [])),
    ]
    for (const a of anchors) {
      const q = map.project(a.coord)
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < MAGNET_RADIUS_PX && (!best || d < best.d)) best = { ...a, d }
    }
    if (!best) { clearPlaceMagnet(); return }
    if (placeMagRef.current?.key === best.key) return
    clearPlaceMagnet()
    const st = { key: best.key, coord: best.coord, since: Date.now(), armed: false }
    placeMagRef.current = st
    if (placeDown.current) { placePanPaused.current = true; map.dragPan.disable() }
    setPlaceMag({ coord: st.coord, since: st.since, armed: false })
    placeDwellTimer.current = setTimeout(() => {
      const now = placeMagRef.current
      if (!now || now.key !== st.key) return
      now.armed = true
      setPlaceMag({ coord: now.coord, since: now.since, armed: true })
      buzz()
    }, MAGNET_DWELL_MS)
  }
  /** the coord this tap actually places — the claimed symbol's own spot if its ring closed */
  const placedCoord = (lc: LngLat): LngLat => {
    const armed = placeMagRef.current?.armed ? placeMagRef.current.coord : null
    clearPlaceMagnet()
    return armed ?? lc
  }

  return {
    /** the «halten, dann verbindet es» ring on the symbol a tap is claiming */
    placeMag,
    down: (at: LngLat) => { placeDown.current = true; trackPlaceMagnet(at) },
    move: (at: LngLat) => { if (placeDown.current) trackPlaceMagnet(at) },
    up: () => { placeDown.current = false },
    /** a pan began: panning away is not a tap on anything */
    cancel: () => { placeDown.current = false; clearPlaceMagnet() },
    /** has the claimed symbol's ring closed? (an armed claim places on the release itself) */
    armed: () => !!placeMagRef.current?.armed,
    placedCoord,
  }
}
