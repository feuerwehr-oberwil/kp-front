import { useEffect, useRef } from 'react'

const DELAY_MS = 500       // hold this long (without moving) to fire — long enough not to clash with a drag
const MOVE_TOL_PX = 8      // any movement past this is a drag/reshape, not a press → cancel

/**
 * Touch long-press, generalised from lib/useHoldEntry. Built for handles that ALSO sit
 * inside a react-map-gl draggable Marker: a still press fires onLongPress; the moment the
 * finger moves (a reshape drag) the press cancels. Movement + release are tracked on
 * `window` (capture phase) so it stays correct even when maplibre takes pointer capture
 * for the drag — the element's own pointer events would otherwise stop arriving.
 *
 * `press(fn)` returns the onPointerDown to spread on a handle; one hook instance serves a
 * whole list of handles (only one press is ever live at a time). `cancel()` lets the
 * Marker's onDrag abort the press the instant a real drag begins.
 */
export function useLongPress(opts?: { delayMs?: number; moveTolerancePx?: number }) {
  const delayMs = opts?.delayMs ?? DELAY_MS
  const tol = opts?.moveTolerancePx ?? MOVE_TOL_PX
  const st = useRef<{
    timer: number
    sx: number
    sy: number
    cb: () => void
    onMove: (e: PointerEvent) => void
    onUp: () => void
  } | null>(null)

  const cancel = () => {
    const s = st.current
    if (!s) return
    clearTimeout(s.timer)
    window.removeEventListener('pointermove', s.onMove, true)
    window.removeEventListener('pointerup', s.onUp, true)
    window.removeEventListener('pointercancel', s.onUp, true)
    st.current = null
  }

  const begin = (e: React.PointerEvent, fn: () => void) => {
    cancel()
    const onMove = (ev: PointerEvent) => {
      const s = st.current
      if (s && Math.hypot(ev.clientX - s.sx, ev.clientY - s.sy) > tol) cancel()
    }
    const onUp = () => cancel()
    const timer = window.setTimeout(() => {
      const s = st.current
      cancel()
      s?.cb()
    }, delayMs)
    st.current = { timer, sx: e.clientX, sy: e.clientY, cb: fn, onMove, onUp }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  useEffect(() => cancel, [])  // drop a pending press if the host unmounts mid-hold

  return {
    cancel,
    press: (fn: () => void) => ({ onPointerDown: (e: React.PointerEvent) => begin(e, fn) }),
  }
}
