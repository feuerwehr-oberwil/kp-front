import { useRef, useState, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoardAnno, BoardTool } from '../types'
import { isMarqueeTap, marqueeContains } from '../lib/marquee'

interface BoardGesturesDeps {
  tool: BoardTool
  annos: BoardAnno[]
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
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

/**
 * The board's NAVIGATION pointer layer, lifted out of the Whiteboard god-component: one-finger
 * pan, two-finger pinch-zoom, and the Mehrfach/lasso marquee multi-select — plus the shared stage
 * dispatcher that routes raw pointer events between them. Object manipulation (chip / freehand /
 * vertex drag) stays in Whiteboard and is reached through the manipMove/manipUp callbacks, so the
 * delicate stopPropagation/setPointerCapture grammar of those drags is untouched.
 *
 * The dispatch order is pinch > marquee > pan, then fall through to manipulation; on release
 * every gesture's up runs (each no-ops if its ref is null). Pointer bookkeeping and the handoff
 * to the two-finger gesture happen in the CAPTURE phase (trackDown/trackUp) so they see fingers
 * that a chip's own handler swallows — see the comment there.
 */
export function useBoardGestures({ tool, annos, setSelId, setSelIds, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp }: BoardGesturesDeps) {
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const pan = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)
  const pinchMid = useRef<{ x: number; y: number } | null>(null)
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

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
    const ids = annos.filter((a) =>
      a.kind === 'draw'
        ? (a.pts ?? []).some(([x, y]) => inBox({ x, y, floor: a.floor }))
        : inBox({ x: a.x ?? 0, y: a.y ?? 0, floor: a.floor }),
    ).map((a) => a.id)
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
  const trackDown = (e: ReactPointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size !== 2 || (tool !== 'pan' && tool !== 'lasso')) return
    pan.current = null; marqueeRef.current = null; setMarquee(null) // hand off to pinch
    manipUp() // an object drag under the first finger ends where it lies — two fingers navigate
    const m = pinchPts()
    pinchDist.current = m?.dist ?? null
    pinchMid.current = m ? { x: m.mx, y: m.my } : null
  }
  const trackUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size >= 2 || pinchDist.current == null) return
    pinchDist.current = null; pinchMid.current = null
    // lifting to a single finger resumes panning from where it rests
    const rem = [...pointers.current.values()][0]
    if (rem && tool === 'pan') pan.current = { x: rem.x, y: rem.y, px: posRef.current.x, py: posRef.current.y }
  }

  const stageDown = (e: ReactPointerEvent) => {
    if (pinchDist.current != null) return // the capture pass handed this gesture to the pinch
    if (tool === 'lasso') { marqueeDown(e); return }
    panDown(e)
  }
  const stageMove = (e: ReactPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
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

  return { marquee, stageDown, stageMove, stageUp, trackDown, trackUp }
}
