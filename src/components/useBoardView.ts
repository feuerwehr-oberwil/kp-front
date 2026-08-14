import { useEffect, useRef, useState, type RefObject } from 'react'
import { TOP_INSET } from '../lib/whiteboard'

/**
 * The Whiteboard's zoom/pan view state. Zoom is by LAYOUT (board pixel size = fit ×
 * scale), not a CSS transform, so the PDF + symbols + text re-rasterize crisply at the
 * actual zoom. Mirrors scale/pos into refs so wheel/pinch/button math reads current
 * values synchronously (StrictMode-safe). Owns the focal-point wheel-zoom listener.
 */
/** Zoom bounds. 1 is «eingepasst» (the board exactly fills the canvas), NOT a real-world
 *  scale — so the floor below it buys margin AROUND the plan: room to drag a symbol to an
 *  edge, and a whole Gebäude floor-stack in one view. Below fit the board stays centred
 *  (see zoomTo), because panning a board smaller than its canvas only loses it. */
export const MIN_SCALE = 0.6
export const MAX_SCALE = 6

export function useBoardView(
  canvasRef: RefObject<HTMLDivElement | null>,
  /** the canvas element as state — re-attaches the wheel listener when the canvas
   *  (re)mounts, e.g. after the Whiteboard first rendered a viewer-only doc without it */
  canvasEl?: HTMLDivElement | null,
) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  // refs mirror scale/pos so wheel/zoom math reads current values synchronously
  // (StrictMode-safe: no impure state updaters)
  const scaleRef = useRef(1)
  const posRef = useRef({ x: 0, y: 0 })
  const applyView = (s: number, p: { x: number; y: number }) => {
    scaleRef.current = s; posRef.current = p; setScale(s); setPos(p)
  }

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  // zoom keeping a focal point fixed — cursor for the wheel, centre for the buttons
  const zoomTo = (factor: number, mx?: number, my?: number) => {
    const el = canvasRef.current; if (!el) return
    const s = scaleRef.current, p = posRef.current
    const n = clamp(s * factor); if (n === s) return
    // at or below fit the board is no larger than the canvas, so there is nothing to pan to:
    // it snaps back to dead centre. That also makes zooming out THROUGH fit land on the
    // familiar eingepasst view instead of an off-centre one.
    if (n <= 1) { applyView(n, { x: 0, y: 0 }); return }
    const k = n / s
    // board is rendered centred + TOP_INSET/2 lower (see the board transform), so
    // the y focal centre is the canvas centre shifted down by the same amount
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2 + TOP_INSET / 2
    const fx = mx ?? cx, fy = my ?? cy
    applyView(n, { x: (fx - cx) * (1 - k) + k * p.x, y: (fy - cy) * (1 - k) + k * p.y })
  }
  const zoom = (f: number) => zoomTo(f)
  useEffect(() => {
    const el = canvasEl ?? canvasRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canvasEl]) // eslint-disable-line react-hooks/exhaustive-deps

  return { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom, clamp }
}
