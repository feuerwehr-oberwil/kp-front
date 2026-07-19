import { useRef, useState, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoardAnno, BoardTool } from '../types'

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
 * The dispatch order is byte-for-byte the old inline behaviour: pinch > marquee > pan, then fall
 * through to manipulation; on release every gesture's up runs (each no-ops if its ref is null).
 */
export function useBoardGestures({ tool, annos, setSelId, setSelIds, applyView, zoomTo, scaleRef, posRef, canvasRef, boardRef, mapY, manipMove, manipUp }: BoardGesturesDeps) {
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const pan = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)
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
    if (Math.abs(r.x1 - r.x0) < 6 && Math.abs(r.y1 - r.y0) < 6) { setSelIds([]); return } // a tap, not a box
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect || !rect.width) return
    const minX = Math.min(r.x0, r.x1), maxX = Math.max(r.x0, r.x1), minY = Math.min(r.y0, r.y1), maxY = Math.max(r.y0, r.y1)
    const inBox = (x: number, y: number, floor: number | undefined) => {
      const cx = rect.left + x * rect.width, cy = rect.top + mapY(floor, y) * rect.height
      return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY
    }
    const ids = annos.filter((a) =>
      a.kind === 'draw' ? (a.pts ?? []).some(([x, y]) => inBox(x, y, a.floor)) : inBox(a.x ?? 0, a.y ?? 0, a.floor),
    ).map((a) => a.id)
    setSelId(null); setSelIds(ids)
  }
  const panMove = (e: ReactPointerEvent) => {
    if (!pan.current) return
    applyView(scaleRef.current, { x: pan.current.px + (e.clientX - pan.current.x), y: pan.current.py + (e.clientY - pan.current.y) })
  }
  const panUp = () => { pan.current = null }

  // --- two-finger pinch-to-zoom (modules, Gebäude floor-stack, any board) ---
  // Tracks active pointers; with two down on the board we zoom by their distance
  // ratio around their midpoint (same focal-point math as the wheel). Mirrors
  // scaleRef so it composes with the +/− buttons and the wheel.
  const pinchPts = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a || !b) return null
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }
  const stageDown = (e: ReactPointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if ((tool === 'pan' || tool === 'lasso') && pointers.current.size === 2) {
      pan.current = null; marqueeRef.current = null; setMarquee(null) // hand off to pinch
      pinchDist.current = pinchPts()?.dist ?? null
      return
    }
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
      pinchDist.current = m.dist
      return
    }
    if (marqueeRef.current) marqueeMove(e)
    else if (pan.current) panMove(e)
    else manipMove(e)
  }
  const stageUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2 && pinchDist.current != null) {
      pinchDist.current = null
      // lifting to a single finger resumes panning from where it rests
      const rem = [...pointers.current.values()][0]
      if (rem && tool === 'pan') pan.current = { x: rem.x, y: rem.y, px: posRef.current.x, py: posRef.current.y }
    }
    if (pointers.current.size === 0) { panUp(); marqueeUp(); manipUp() }
  }

  return { marquee, stageDown, stageMove, stageUp }
}
