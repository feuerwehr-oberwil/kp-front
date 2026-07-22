import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LineAttachment, LngLat } from '../types'
import { haversineM } from '../lib/geo'
import { rdpIndices, FREEHAND_SIMPLIFY_PX } from '../lib/lineStyle'

type Rect = { x0: number; y0: number; x1: number; y1: number }
type Circle = { center: LngLat; radiusM: number }

interface Args {
  mapInst: RefObject<MlMap | null>
  mapReady: boolean
  freehand: boolean
  onFreehand: (coords: LngLat[], attachments?: { startAttachment?: LineAttachment; endAttachment?: LineAttachment }) => void
  onFreehandPointer?: (phase: 'start' | 'move' | 'end', coord: LngLat) => { startAttachment?: LineAttachment; endAttachment?: LineAttachment } | void
  marqueeEnabled: boolean
  drawings: Drawing[]
  /** placed map entities (symbols/shapes/notes…) the marquee should also catch */
  entities: Entity[]
  /** report the boxed drawings AND entities so a lasso can grab both */
  onMarquee?: (drawIds: string[], entityIds: string[]) => void
  /** the Absperrkreis (circle) tool is active — drag from centre out to set the radius */
  circleEnabled?: boolean
  /** commit a finished circle (centre + geodesic radius in metres) */
  onCircle?: (center: LngLat, radiusM: number) => void
  /** below this radius a drag counts as a tap → a default-size circle is placed instead */
  circleMinRadiusM?: number
  /** radius a fresh circle starts/snaps to (visible default; also used for a tap) */
  circleInitialRadiusM?: number
}

/**
 * Canvas-level pointer gestures that run directly on the MapLibre instance
 * (freehand drawing + marquee multi-select), toggling dragPan per gesture.
 * Returns the live freehand path and the in-progress marquee box for rendering.
 *
 * IMPORTANT — every gesture's draw-complete callbacks (onFreehand/onCircle/onMarquee) and the
 * marquee's drawings/entities are read through REFS, not effect deps. App re-renders on a 15s
 * cadence (the live-GPS poll recreates these callbacks each render); if those identities sat in
 * the effect deps, a poll landing MID-STROKE would re-run the effect, whose cleanup resets the
 * gesture's active flag + re-enables dragPan — silently killing the in-progress stroke (no
 * commit, no editor, the map pans out from under the finger). Keeping the listeners bound for
 * the whole gesture (deps = enable-flag + mapReady only) is what makes the map match the Plan.
 */
export function useMapCanvasGestures({ mapInst, mapReady, freehand, onFreehand, onFreehandPointer, marqueeEnabled, drawings, entities, onMarquee, circleEnabled = false, onCircle, circleMinRadiusM = 5, circleInitialRadiusM = 25 }: Args) {
  const [fhPath, setFhPath] = useState<LngLat[] | null>(null)

  // Freehand drawing happens ON the map canvas (not a blocking overlay) so the map can
  // still be moved while the pen is active: ONE finger draws, TWO fingers pan/zoom, and
  // on desktop holding Space pans. We toggle maplibre's dragPan per gesture — disabled
  // for a single-finger/mouse stroke, re-enabled the moment a 2nd finger lands.
  const fhActive = useRef(false)
  const usingTouch = useRef(false)
  const spaceHeld = useRef(false)
  // Raw stroke points live in a REF (not state) so a captured point doesn't re-render the heavy
  // MapView on every pointer sample — that per-point render janks the main thread and the browser
  // then coalesces away touch samples, thinning the stroke ("blocky, few nodes"). We mirror the
  // ref into `fhPath` state once per animation frame, purely to draw the live preview.
  const fhPoints = useRef<LngLat[]>([])
  const fhRaf = useRef<number | null>(null)
  // "latest ref" mirrors — synced in an effect (NOT during render) so the gesture effects can
  // read fresh callbacks/data without listing them as deps (which would rebind mid-stroke).
  const onFreehandRef = useRef(onFreehand)
  const onFreehandPointerRef = useRef(onFreehandPointer)
  const drawingsRef = useRef(drawings)
  const entitiesRef = useRef(entities)
  const onMarqueeRef = useRef(onMarquee)
  const onCircleRef = useRef(onCircle)
  useEffect(() => {
    onFreehandRef.current = onFreehand
    onFreehandPointerRef.current = onFreehandPointer
    drawingsRef.current = drawings
    entitiesRef.current = entities
    onMarqueeRef.current = onMarquee
    onCircleRef.current = onCircle
  })
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady || !freehand) return
    const cancelRaf = () => { if (fhRaf.current != null) { cancelAnimationFrame(fhRaf.current); fhRaf.current = null } }
    const flushPreview = () => { fhRaf.current = null; if (fhActive.current) setFhPath(fhPoints.current.slice()) }
    const schedule = () => { if (fhRaf.current == null) fhRaf.current = requestAnimationFrame(flushPreview) }
    const start = (ll: LngLat) => { fhActive.current = true; fhPoints.current = [ll]; setFhPath([ll]); map.dragPan.disable(); onFreehandPointerRef.current?.('start', ll) }
    const addPoint = (ll: LngLat) => { fhPoints.current.push(ll); schedule(); onFreehandPointerRef.current?.('move', ll) }
    const finish = (commit: boolean) => {
      map.dragPan.enable()
      cancelRaf()
      if (!fhActive.current) return
      fhActive.current = false
      const p = fhPoints.current
      fhPoints.current = []
      setFhPath(null)
      const attachments = p.length ? onFreehandPointerRef.current?.('end', p[p.length - 1]) || undefined : undefined
      if (commit && p.length >= 2) {
        // thin the raw stroke into a clean, editable polyline before committing — project to
        // screen px so the tolerance is zoom-correct, keep the RDP nodes (parity with the Plan).
        const px = p.map((c) => { const pt = map.project(c as [number, number]); return [pt.x, pt.y] as [number, number] })
        const idx = rdpIndices(px, FREEHAND_SIMPLIFY_PX)
        onFreehandRef.current(idx.length >= 2 ? idx.map((i) => p[i]) : p, attachments)
      }
    }
    const onTouchStart = (e: any) => {
      usingTouch.current = true
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { finish(false); return } // 2 fingers → let the map pan/zoom
      start([e.lngLat.lng, e.lngLat.lat])
    }
    const onTouchMove = (e: any) => {
      if (!fhActive.current) return
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { finish(false); return }
      addPoint([e.lngLat.lng, e.lngLat.lat])
    }
    const onTouchEnd = (e: any) => { if ((e.originalEvent.touches?.length ?? 0) === 0) finish(true) }
    const onMouseDown = (e: any) => { if (usingTouch.current || spaceHeld.current) return; start([e.lngLat.lng, e.lngLat.lat]) }
    const onMouseMove = (e: any) => { if (!fhActive.current || usingTouch.current) return; addPoint([e.lngLat.lng, e.lngLat.lat]) }
    const onMouseUp = () => { if (!usingTouch.current) finish(true) }
    map.on('touchstart', onTouchStart); map.on('touchmove', onTouchMove); map.on('touchend', onTouchEnd)
    map.on('mousedown', onMouseDown); map.on('mousemove', onMouseMove); map.on('mouseup', onMouseUp)
    return () => {
      map.off('touchstart', onTouchStart); map.off('touchmove', onTouchMove); map.off('touchend', onTouchEnd)
      map.off('mousedown', onMouseDown); map.off('mousemove', onMouseMove); map.off('mouseup', onMouseUp)
      cancelRaf()
      map.dragPan.enable(); fhActive.current = false; fhPoints.current = []
    }
  }, [freehand, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps -- mapInst stable; onFreehand read via ref so a mid-stroke App re-render can't rebind
  // desktop: hold Space to pan instead of drawing
  useEffect(() => {
    if (!freehand) return
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld.current = true }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld.current = false }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); spaceHeld.current = false }
  }, [freehand])

  // marquee multi-select — only active while the dedicated lasso tool is chosen, so the
  // gesture is unambiguous: ONE finger / a plain mouse drag boxes (two fingers still
  // pan/zoom on touch). On release, every drawing with a vertex inside the box is selected.
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const marqueeRef = useRef<Rect | null>(null)
  const mUsingTouch = useRef(false)
  // drawings/entities/onMarquee are read through the latest-ref mirrors above so the listeners
  // stay bound across App re-renders (a poll updating them mid-drag must NOT tear the gesture down).
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady || !marqueeEnabled) return
    const setRect = (r: Rect) => { marqueeRef.current = r; setMarquee(r) }
    const clientXY = (e: any): [number, number] => {
      const oe = e.originalEvent
      const t = oe.touches?.[0] ?? oe.changedTouches?.[0]
      return t ? [t.clientX, t.clientY] : [oe.clientX, oe.clientY]
    }
    const begin = (cx: number, cy: number) => { setRect({ x0: cx, y0: cy, x1: cx, y1: cy }); map.dragPan.disable() }
    const cancel = () => { map.dragPan.enable(); marqueeRef.current = null; setMarquee(null) }
    const commitSel = () => {
      map.dragPan.enable()
      const r = marqueeRef.current; marqueeRef.current = null; setMarquee(null)
      if (!r) return
      if (Math.abs(r.x1 - r.x0) < 6 && Math.abs(r.y1 - r.y0) < 6) return // a tap, not a box → let click select
      const minX = Math.min(r.x0, r.x1), maxX = Math.max(r.x0, r.x1), minY = Math.min(r.y0, r.y1), maxY = Math.max(r.y0, r.y1)
      const rect = map.getContainer().getBoundingClientRect()
      const inBox = (lng: number, lat: number) => {
        const p = map.project([lng, lat] as [number, number])
        const cx = rect.left + p.x, cy = rect.top + p.y
        return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY
      }
      // a drawing is caught if any vertex falls in the box; an entity if its point does
      const drawIds = drawingsRef.current.filter((d) => Array.isArray(d.coords) && d.coords.some(([lng, lat]) => inBox(lng, lat))).map((d) => d.id)
      const entityIds = entitiesRef.current.filter((e) => Array.isArray(e.coord) && inBox(e.coord[0], e.coord[1])).map((e) => e.id)
      onMarqueeRef.current?.(drawIds, entityIds)
    }
    const onTouchStart = (e: any) => {
      mUsingTouch.current = true
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { cancel(); return }
      const [cx, cy] = clientXY(e); begin(cx, cy)
    }
    const onTouchMove = (e: any) => {
      if (!marqueeRef.current) return
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { cancel(); return }
      const [cx, cy] = clientXY(e); setRect({ ...marqueeRef.current, x1: cx, y1: cy })
    }
    const onTouchEnd = (e: any) => { if ((e.originalEvent.touches?.length ?? 0) === 0 && marqueeRef.current) commitSel() }
    const onMouseDown = (e: any) => { if (mUsingTouch.current) return; const [cx, cy] = clientXY(e); begin(cx, cy) }
    const onMouseMove = (e: any) => { if (!marqueeRef.current || mUsingTouch.current) return; const [cx, cy] = clientXY(e); setRect({ ...marqueeRef.current, x1: cx, y1: cy }) }
    const onMouseUp = () => { if (!mUsingTouch.current && marqueeRef.current) commitSel() }
    map.on('touchstart', onTouchStart); map.on('touchmove', onTouchMove); map.on('touchend', onTouchEnd)
    map.on('mousedown', onMouseDown); map.on('mousemove', onMouseMove); map.on('mouseup', onMouseUp)
    return () => {
      map.off('touchstart', onTouchStart); map.off('touchmove', onTouchMove); map.off('touchend', onTouchEnd)
      map.off('mousedown', onMouseDown); map.off('mousemove', onMouseMove); map.off('mouseup', onMouseUp)
      map.dragPan.enable(); marqueeRef.current = null
    }
  }, [marqueeEnabled, mapReady]) // eslint-disable-line react-hooks/exhaustive-deps -- mapInst stable; drawings/entities/onMarquee read via refs so a poll mid-drag can't rebind

  // Absperrkreis (Gefahrenradius) — drag from the centre outward to size the circle.
  // Same gesture grammar as the marquee: ONE finger / plain mouse drag draws, TWO fingers
  // still pan/zoom on touch. The radius is the geodesic distance centre→pointer, so the
  // ring edge tracks the finger. Released below the min radius = a stray tap, discarded.
  const [circle, setCircle] = useState<Circle | null>(null)
  const circleRef = useRef<Circle | null>(null)
  const cUsingTouch = useRef(false)
  useEffect(() => {
    const map = mapInst.current
    if (!map || !mapReady || !circleEnabled) return
    const set = (c: Circle | null) => { circleRef.current = c; setCircle(c) }
    // start the preview at the default radius so the ring is visible the instant the
    // finger lands ("something is here, drag to size it") instead of a zero-size point.
    const begin = (ll: LngLat) => { set({ center: ll, radiusM: circleInitialRadiusM }); map.dragPan.disable() }
    const update = (ll: LngLat) => { const c = circleRef.current; if (c) set({ center: c.center, radiusM: haversineM(c.center, ll) }) }
    const cancel = () => { map.dragPan.enable(); set(null) }
    const finish = () => {
      map.dragPan.enable()
      const c = circleRef.current; set(null)
      // a real drag uses the dragged radius; a tap (under the min) drops a default-size
      // circle so the tool never does "nothing" — the radius is then editable.
      if (c) onCircleRef.current?.(c.center, Math.round(c.radiusM >= circleMinRadiusM ? c.radiusM : circleInitialRadiusM))
    }
    const ll = (e: any): LngLat => [e.lngLat.lng, e.lngLat.lat]
    const onTouchStart = (e: any) => {
      cUsingTouch.current = true
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { cancel(); return }
      begin(ll(e))
    }
    const onTouchMove = (e: any) => {
      if (!circleRef.current) return
      if ((e.originalEvent.touches?.length ?? 1) >= 2) { cancel(); return }
      update(ll(e))
    }
    const onTouchEnd = (e: any) => { if ((e.originalEvent.touches?.length ?? 0) === 0 && circleRef.current) finish() }
    const onMouseDown = (e: any) => { if (cUsingTouch.current) return; begin(ll(e)) }
    const onMouseMove = (e: any) => { if (!circleRef.current || cUsingTouch.current) return; update(ll(e)) }
    const onMouseUp = () => { if (!cUsingTouch.current && circleRef.current) finish() }
    map.on('touchstart', onTouchStart); map.on('touchmove', onTouchMove); map.on('touchend', onTouchEnd)
    map.on('mousedown', onMouseDown); map.on('mousemove', onMouseMove); map.on('mouseup', onMouseUp)
    return () => {
      map.off('touchstart', onTouchStart); map.off('touchmove', onTouchMove); map.off('touchend', onTouchEnd)
      map.off('mousedown', onMouseDown); map.off('mousemove', onMouseMove); map.off('mouseup', onMouseUp)
      map.dragPan.enable(); circleRef.current = null
    }
  }, [circleEnabled, mapReady, circleMinRadiusM, circleInitialRadiusM]) // eslint-disable-line react-hooks/exhaustive-deps -- mapInst stable; onCircle read via ref so a poll mid-drag can't rebind

  return { fhPath, marquee, circle }
}
