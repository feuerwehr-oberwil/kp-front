import { useEffect, useRef, useState, type RefObject } from 'react'
import { TOP_INSET } from '../lib/whiteboard'

/**
 * The Whiteboard's zoom/pan view state. Zoom is by LAYOUT (board pixel size = fit ×
 * scale), not a CSS transform, so the PDF + symbols + text re-rasterize crisply at the
 * actual zoom. Mirrors scale/pos into refs so wheel/pinch/button math reads current
 * values synchronously (StrictMode-safe). Owns the focal-point wheel-zoom listener.
 */
export function useBoardView(canvasRef: RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  // refs mirror scale/pos so wheel/zoom math reads current values synchronously
  // (StrictMode-safe: no impure state updaters)
  const scaleRef = useRef(1)
  const posRef = useRef({ x: 0, y: 0 })
  const applyView = (s: number, p: { x: number; y: number }) => {
    scaleRef.current = s; posRef.current = p; setScale(s); setPos(p)
  }

  const clamp = (s: number) => Math.min(6, Math.max(1, s))
  // zoom keeping a focal point fixed — cursor for the wheel, centre for the buttons
  const zoomTo = (factor: number, mx?: number, my?: number) => {
    const el = canvasRef.current; if (!el) return
    const s = scaleRef.current, p = posRef.current
    const n = clamp(s * factor); if (n === s) return
    if (n === 1) { applyView(1, { x: 0, y: 0 }); return }
    const k = n / s
    // board is rendered centred + TOP_INSET/2 lower (see the board transform), so
    // the y focal centre is the canvas centre shifted down by the same amount
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2 + TOP_INSET / 2
    const fx = mx ?? cx, fy = my ?? cy
    applyView(n, { x: (fx - cx) * (1 - k) + k * p.x, y: (fy - cy) * (1 - k) + k * p.y })
  }
  const zoom = (f: number) => zoomTo(f)
  useEffect(() => {
    const el = canvasRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom, clamp }
}
