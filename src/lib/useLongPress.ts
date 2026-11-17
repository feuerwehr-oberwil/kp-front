import { useEffect, useRef, useState } from 'react'
import { HOLD_OFFER_MS } from './holdTimings'

/** Hold this long (without moving) to fire – the OFFER window (lib/holdTimings; 500 until
 *  17.11.2026). Exported because a hold on the map canvas cannot use this hook (it listens on
 *  maplibre's container, not on a React element): karte/useKartePointer · useMapPress. */
export const LONG_PRESS_MS = HOLD_OFFER_MS
/** any movement past this is a drag/reshape, not a press → cancel */
export const LONG_PRESS_MOVE_TOL_PX = 8

/**
 * Touch long-press, generalised from lib/useHoldEntry. Built for handles that ALSO sit
 * inside a react-map-gl draggable Marker: a still press fires onLongPress; the moment the
 * finger moves (a reshape drag) the press cancels. Movement + release are tracked on
 * `window` (capture phase) so it stays correct even when maplibre takes pointer capture
 * for the drag — the element's own pointer events would otherwise stop arriving.
 *
 * `press(fn, key?)` returns the onPointerDown (+ `data-holdaction`) to spread on a handle; one hook
 * instance serves a whole list of handles (only one press is ever live at a time). `cancel()`
 * lets the Marker's onDrag abort the press the instant a real drag begins. `held` names the
 * handle being held (its `key`) and since when – the host paints `HoldChargeRing` from it, so
 * every hold that acts warns the finger before it fires (ui-conventions › Touch vocabulary).
 */
export function useLongPress(opts?: { delayMs?: number; moveTolerancePx?: number }) {
  const delayMs = opts?.delayMs ?? LONG_PRESS_MS
  const tol = opts?.moveTolerancePx ?? LONG_PRESS_MOVE_TOL_PX
  const [held, setHeld] = useState<{ key: string; since: number } | null>(null)
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
    setHeld(null)
  }

  const begin = (e: React.PointerEvent, fn: () => void, key: string) => {
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
    setHeld({ key, since: Date.now() })
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  useEffect(() => cancel, [])  // drop a pending press if the host unmounts mid-hold

  return {
    cancel,
    held,
    // `data-holdaction`: the hold IS this control's gesture, so the app-wide hold-tooltip
    // (lib/holdTooltip) must not answer the same press with a label bubble first
    press: (fn: () => void, key = '') => ({ 'data-holdaction': true as const, onPointerDown: (e: React.PointerEvent) => begin(e, fn, key) }),
  }
}
