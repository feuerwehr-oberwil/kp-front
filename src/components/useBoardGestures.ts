import { useRef, useState, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoardAnno, BoardTool } from '../types'
import { isMarqueeTap, marqueeContains } from '../lib/marquee'
import { createTapDragZoom, type OneFingerZoom, type TapSample, type TapZoomAction } from '../lib/tapDragZoom'

interface BoardGesturesDeps {
  tool: BoardTool
  annos: BoardAnno[]
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
  /** arm a tool — the marquee uses it to hand a single catch back to the selection tool */
  setTool: (t: BoardTool) => void
  applyView: (s: number, p: { x: number; y: number }) => void
  zoomTo: (factor: number, mx?: number, my?: number) => void
  scaleRef: MutableRefObject<number>
  posRef: MutableRefObject<{ x: number; y: number }>
  canvasRef: RefObject<HTMLDivElement | null>
  boardRef: RefObject<HTMLDivElement | null>
  mapY: (floor: number | undefined, y: number) => number
  /** dispatch a pointer-move to the active object-manipulation drag (chip/draw/vertex), if any */
  manipMove: (e: ReactPointerEvent) => void
  /** end every object-manipulation drag (chip/draw/vertex up — each no-ops if inactive) */
  manipUp: () => void
}

/** Presses that never count toward the board's one-finger zoom: a control (a second tap on
 *  «+ UG» is a second storey), a note or Trupp chip (its double tap opens the name for editing —
 *  PlanAnno), and everything while the georef mode is armed (it owns the sheet's presses —
 *  GeorefMode). An object's grips (`button.handle`) DO count: selecting a symbol mounts them right
 *  under the finger, and the second tap there is the double tap's, not a turn. */
const NOT_A_ZOOM_PRESS = 'button:not(.handle), input, textarea, select, a[href], [contenteditable], [role="button"], [role="slider"], .wb-anno.wb-text, .wb-anno.wb-resource, .wb-georef-armed'

/**
 * The board's NAVIGATION pointer layer, lifted out of the Whiteboard god-component: one-finger
 * pan, two-finger pinch-zoom, the one-finger double-tap / tap-and-drag zoom (lib/tapDragZoom,
 * 08.10.2026), and the Mehrfach/lasso marquee multi-select — plus the shared stage dispatcher
 * that routes raw pointer events between them. Object manipulation (chip / freehand /
 * vertex drag) stays in Whiteboard and is reached through the manipMove/manipUp callbacks, so the
 * delicate stopPropagation/setPointerCapture grammar of those drags is untouched.
 *
 * The dispatch order is pinch > tap-zoom > marquee > pan, then fall through to manipulation; on release
 * every gesture's up runs (each no-ops if its ref is null). Pointer bookkeeping and the handoff
 * to the two-finger gesture happen in the CAPTURE phase (trackDown/trackUp) so they see fingers
 * that a chip's own handler swallows — see the comment there.
 */
export function useBoardGestures({ tool, annos, setSelId, setSelIds, setTool, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp }: BoardGesturesDeps) {
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const pan = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)
  const pinchMid = useRef<{ x: number; y: number } | null>(null)
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // --- one-finger zoom, the Karte's own (MapLibre's double tap + tap-and-drag) — touch and pen.
  // Under a tool the one rule of lib/tapDragZoom · oneFingerZoom (sweep 27.10.2026 #8): Auswahl
  // and Mehrfach have both (the Rahmen starts on a FRESH press, the second press of a tap pair is
  // the zoom's); the create tools reach it through `tapZoomPress` from the ink — Messen keeps
  // tap-and-drag, Freihand the double tap, a tap-to-place tool navigates by pinch. A double tap never
  // finishes a Linie / Fläche — ✓ does.
  // Under Auswahl / Mehrfach the presses are counted in the CAPTURE pass (trackDown), so a press on
  // a symbol, a line, a wall or a label counts like one on empty paper (sweep 28.10.2026 #4 — owner:
  // «It should just work reliably across all different maps and plans»; on a busy Gebäude hardly
  // any press used to reach the zoom): the first tap still selects as before, the second press of
  // the pair is the zoom's and never reaches the object. Not counted: controls, the notes and
  // Trupp chips whose own double tap opens their name for editing, and the georef mode, which owns
  // every press on the sheet (NOT_A_ZOOM_PRESS). ---
  const [tapZoom] = useState(createTapDragZoom)
  /** the scale the tap-drag engaged at — its factor is relative to that, so it never drifts */
  const tapZoomBase = useRef<number | null>(null)
  const countsForZoom = (e: ReactPointerEvent) => !(e.target as Element | null)?.closest?.(NOT_A_ZOOM_PRESS)
  const sample = (e: ReactPointerEvent): TapSample => ({ id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, pointerType: e.pointerType })
  const applyTapZoom = (a: TapZoomAction | null) => {
    if (!a || a.kind === 'hold') return
    if (a.kind === 'arm' || a.kind === 'end') { tapZoomBase.current = null; return }
    const r = canvasRef.current?.getBoundingClientRect()
    const fx = a.at.x - (r?.left ?? 0), fy = a.at.y - (r?.top ?? 0)
    if (a.kind === 'zoomStep') { zoomTo(2, fx, fy); return }
    tapZoomBase.current ??= scaleRef.current
    // an ABSOLUTE target (base × factor) — zoomTo clamps it and keeps the first tap's spot fixed
    zoomTo((tapZoomBase.current * a.factor) / scaleRef.current, fx, fy)
  }

  // --- panning (pan tool, on empty board) ---
  const panDown = (e: ReactPointerEvent) => {
    if (tool !== 'pan') return
    pan.current = { x: e.clientX, y: e.clientY, px: posRef.current.x, py: posRef.current.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setSelId(null); setSelIds([])
  }

  // --- marquee (Mehrfach/lasso) multi-select — same gesture grammar as the map: ONE
  // finger / a plain mouse drag boxes, TWO fingers still pinch-zoom. On release every
  // anno whose anchor (or any draw vertex) falls in the box joins the group. ---
  const marqueeDown = (e: ReactPointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    marqueeRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }
    setMarquee(marqueeRef.current)
    setSelId(null); setSelIds([])
  }
  const marqueeMove = (e: ReactPointerEvent) => {
    if (!marqueeRef.current) return
    marqueeRef.current = { ...marqueeRef.current, x1: e.clientX, y1: e.clientY }
    setMarquee(marqueeRef.current)
  }
  const marqueeUp = () => {
    const r = marqueeRef.current; marqueeRef.current = null; setMarquee(null)
    if (!r) return
    if (isMarqueeTap(r)) { setSelIds([]); return } // a tap, not a box
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect || !rect.width) return
    // project a normalized board point (x, y, floor) into client px; shared bounds test does the rest
    const inBox = marqueeContains(r, ({ x, y, floor }: { x: number; y: number; floor: number | undefined }) => ({
      cx: rect.left + x * rect.width, cy: rect.top + mapY(floor, y) * rect.height,
    }))
    // anything LOCKED is click-through (its LockChip is the only door) — the lasso may neither
    // move, delete nor select it, exactly as on the Lage map (IncidentWorkspace · onMarquee)
    const ids = annos.filter((a) =>
      !a.locked && (a.kind === 'draw'
        ? (a.pts ?? []).some(([x, y]) => inBox({ x, y, floor: a.floor }))
        : inBox({ x: a.x ?? 0, y: a.y ?? 0, floor: a.floor })),
    ).map((a) => a.id)
    // Exactly one caught → drop into the normal single-edit selection, so the object gets its
    // editor, its grips and its Löschen; a group of one has none of that (groupCentroid needs
    // two). Same fallback as the Karte (IncidentWorkspace · onMarquee), and like the Karte it
    // hands the surface back to the selection tool — that IS where the single-edit affordances
    // live ('pan' gates the editor slot and the vertex handles). A box that caught nothing or a
    // real group leaves the lasso armed, as before.
    if (ids.length <= 1) {
      setSelIds([]); setSelId(ids[0] ?? null)
      if (ids.length === 1) setTool('pan')
      return
    }
    setSelId(null); setSelIds(ids)
  }
  const panMove = (e: ReactPointerEvent) => {
    if (!pan.current) return
    applyView(scaleRef.current, { x: pan.current.px + (e.clientX - pan.current.x), y: pan.current.py + (e.clientY - pan.current.y) })
  }
  const panUp = () => { pan.current = null }

  // --- two-finger pinch-zoom AND two-finger pan (modules, Gebäude floor-stack, any board) ---
  // With two pointers down we zoom by their distance ratio around their midpoint (same
  // focal-point math as the wheel) AND move the board by that midpoint's travel — a
  // two-finger drag that holds the fingers' distance steady is a pure pan, which is what
  // the gesture means everywhere else. Mirrors scaleRef so it composes with the wheel.
  const pinchPts = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a || !b) return null
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  // --- pointer bookkeeping — CAPTURE phase ---
  // A chip / vertex / draw handler stops propagation on pointerdown and owns the pointer from
  // there, so with one finger resting on a symbol the stage never saw the SECOND finger and the
  // gesture silently stayed a one-finger drag — "two-finger drag doesn't work" on any board that
  // has something on it. Those pointers were never seen being LIFTED either, so a stale id could
  // linger in the map and make the next gesture behave like a three-finger one. Capture sees
  // every pointer whatever swallows it; these two only bookkeep, they never intercept.
  // ⚠️ A pointerup that never reaches the canvas (its target unmounted mid-press, a sheet opened
  // over it) leaves a GHOST in the map, and from then on every one-finger press counted as a
  // second finger: no pan, no one-finger zoom, a «pinch» against a finger that is not there. A
  // primary pointer is by definition the only one down, so it starts the bookkeeping afresh.
  const trackDown = (e: ReactPointerEvent) => {
    if (e.isPrimary) { pointers.current.clear(); pinchDist.current = null; pinchMid.current = null }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2) applyTapZoom(tapZoom.cancel()) // two fingers are the pinch's
    else if (tool === 'pan' || tool === 'lasso') {
      const a = countsForZoom(e) ? tapZoom.down(sample(e)) : tapZoom.cancel()
      if (a?.kind === 'arm') {
        // the second press of a tap pair: this finger zooms — whatever it landed on gets nothing
        // (no drag, no select, no pan, no Rahmen; the first tap already did the selecting)
        e.stopPropagation()
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }
      applyTapZoom(a)
      return
    }
    if (pointers.current.size !== 2 || (tool !== 'pan' && tool !== 'lasso')) return
    pan.current = null; marqueeRef.current = null; setMarquee(null) // hand off to pinch
    manipUp() // an object drag under the first finger ends where it lies — two fingers navigate
    const m = pinchPts()
    pinchDist.current = m?.dist ?? null
    pinchMid.current = m ? { x: m.mx, y: m.my } : null
  }
  const trackUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    // here, not in stageUp: capture sees every release, also of a press the zoom never counted
    // (a create tool's, or one under a tap-to-place tool) — and that still breaks the pair
    applyTapZoom(e.type === 'pointercancel' ? tapZoom.cancel() : tapZoom.up(sample(e)))
    if (pointers.current.size >= 2 || pinchDist.current == null) return
    pinchDist.current = null; pinchMid.current = null
    // lifting to a single finger resumes panning from where it rests
    const rem = [...pointers.current.values()][0]
    if (rem && tool === 'pan') pan.current = { x: rem.x, y: rem.y, px: posRef.current.x, py: posRef.current.y }
  }

  const stageDown = (e: ReactPointerEvent) => {
    if (pinchDist.current != null) return // the capture pass handed this gesture to the pinch
    // (under Auswahl / Mehrfach trackDown already counted this press for the one-finger zoom, and
    // a press the zoom took never gets here)
    if (tool !== 'pan' && tool !== 'lasso') applyTapZoom(tapZoom.cancel())
    if (tool === 'lasso') { marqueeDown(e); return }
    panDown(e)
  }
  const stageMove = (e: ReactPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // non-null only while the tap-zoom owns this finger; a first press that travels quietly
    // stops being a tap here (and goes on panning below)
    const tz = tapZoom.move(sample(e))
    if (tz) { applyTapZoom(tz); return }
    if (pinchDist.current != null) {
      const m = pinchPts(); if (!m) return
      const el = canvasRef.current
      if (el && pinchDist.current > 0 && m.dist > 0) {
        const r = el.getBoundingClientRect()
        zoomTo(m.dist / pinchDist.current, m.mx - r.left, m.my - r.top)
      }
      // …then follow the midpoint. Only above fit: at or below it the board is no larger than
      // the canvas and stays centred (useBoardView.zoomTo keeps pos at origin there).
      const prev = pinchMid.current
      if (prev && scaleRef.current > 1) {
        applyView(scaleRef.current, { x: posRef.current.x + (m.mx - prev.x), y: posRef.current.y + (m.my - prev.y) })
      }
      pinchDist.current = m.dist
      pinchMid.current = { x: m.mx, y: m.my }
      return
    }
    if (marqueeRef.current) marqueeMove(e)
    else if (pan.current) panMove(e)
    else manipMove(e)
  }
  const stageUp = () => {
    // trackUp (capture) already removed the pointer and closed out any pinch
    if (pointers.current.size === 0) { panUp(); marqueeUp(); manipUp() }
  }

  /** A create tool's press on `.wb-ink`, which swallows it before stageDown, with what the tool
   *  leaves to the zoom (lib/tapDragZoom · oneFingerZoom) — nothing, under a tap-to-place tool:
   *  then the press only forgets any half-made pair. Its moves reach the zoom
   *  through stageMove (they bubble), its release through trackUp; `tapZoomOwns` tells the ink
   *  not to pan or place under a finger the zoom has taken. */
  const tapZoomPress = (e: ReactPointerEvent, allow: OneFingerZoom) =>
    applyTapZoom(allow.step || allow.drag ? tapZoom.down(sample(e), allow) : tapZoom.cancel())

  return { marquee, stageDown, stageMove, stageUp, trackDown, trackUp, tapZoomPress, tapZoomOwns: tapZoom.owns }
}
