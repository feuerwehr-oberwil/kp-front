import { useEffect, useRef } from 'react'

const DELAY_MS = 180     // touch: hold this long (still) before a drag arms — a quick flick stays a map pan
const MOVE_TOL_PX = 8    // movement past this disqualifies a still-hold (touch) / starts a drag (mouse)
const TAP_TOL_PX = 16    // release within this much total movement still counts as a tap — generous for fat fingers

export interface HoldDragCbs {
  /** a tap (quick press that didn't become a drag) — select the marker. Owned here, NOT via the
   *  browser click, because a slightly-moved touch often fires no click at all (the map panned). */
  onTap?: () => void
  /** the drag armed (touch: held still past the delay; mouse: moved) — disable map pan, snapshot start */
  onHoldStart?: () => void
  /** the armed pointer moved — current viewport coords (clientX/clientY) */
  onDragMove?: (clientX: number, clientY: number) => void
  /** the gesture ended after arming — re-enable map pan, commit */
  onDragEnd?: () => void
}

export interface HoldDragOpts {
  /** 'mouse' arms a drag on the first move (desktop click-drag); 'touch' waits for a still hold */
  mode?: 'mouse' | 'touch'
  /** when false the marker can be tapped/selected but never dragged (non-select tool / locked) */
  canDrag?: boolean
}

/**
 * Tap-to-select + press-and-hold-to-drag for placed map markers, without stealing a pan/zoom.
 *
 * Markers are deliberately NOT react-map-gl-draggable: that claims the pointer on pointerdown and
 * suppresses the map's pan, so any pan starting on a symbol drags the symbol instead of the map.
 * Instead this hook leaves the gesture with the map and only takes over when the intent is clear:
 *   • mouse  — a click selects; a press-and-move drags at once (desktop expectation).
 *   • touch  — a tap selects (generous TAP_TOL slop for fat fingers); a still hold past the delay
 *              arms a drag; anything else stays a map pan/zoom.
 * Tap is reported here (onTap) rather than relying on the synthetic click, which a slightly-moved
 * touch often never fires — the cause of "selection didn't register" on mobile.
 *
 * Movement/release are tracked on `window` (capture) so the gesture stays correct once the finger
 * leaves the small marker element. One instance serves a whole list of markers (only one gesture
 * is ever live); `cancel()` lets a sibling gesture (e.g. a transform handle) abort it.
 */
export function useHoldToDrag(opts?: { delayMs?: number; moveTolerancePx?: number; tapTolerancePx?: number }) {
  const delayMs = opts?.delayMs ?? DELAY_MS
  const tol = opts?.moveTolerancePx ?? MOVE_TOL_PX
  const tapTol = opts?.tapTolerancePx ?? TAP_TOL_PX
  const st = useRef<{
    timer: number
    sx: number
    sy: number
    phase: 'pending' | 'pan' | 'drag'
    mode: 'mouse' | 'touch'
    canDrag: boolean
    cbs: HoldDragCbs
    onMove: (e: PointerEvent) => void
    onUp: () => void
  } | null>(null)

  const teardown = () => {
    const s = st.current
    if (!s) return
    clearTimeout(s.timer)
    window.removeEventListener('pointermove', s.onMove, true)
    window.removeEventListener('pointerup', s.onUp, true)
    window.removeEventListener('pointercancel', s.onUp, true)
    st.current = null
  }

  /** abort a pending/active gesture from the outside (e.g. a transform handle took over) */
  const cancel = () => {
    const s = st.current
    if (s?.phase === 'drag') s.cbs.onDragEnd?.()
    teardown()
  }

  const arm = (s: NonNullable<typeof st.current>, clientX: number, clientY: number) => {
    clearTimeout(s.timer)
    s.phase = 'drag'
    s.cbs.onHoldStart?.()
    s.cbs.onDragMove?.(clientX, clientY)
  }

  const begin = (e: { clientX: number; clientY: number }, cbs: HoldDragCbs, o?: HoldDragOpts) => {
    teardown()
    const mode = o?.mode ?? 'touch'
    const canDrag = o?.canDrag ?? true
    const onMove = (ev: PointerEvent) => {
      const s = st.current
      if (!s) return
      if (s.phase === 'drag') { s.cbs.onDragMove?.(ev.clientX, ev.clientY); return }
      if (s.phase !== 'pending') return
      const dist = Math.hypot(ev.clientX - s.sx, ev.clientY - s.sy)
      // mouse: any real move past the slop starts the drag immediately
      if (s.canDrag && s.mode === 'mouse' && dist > tol) { arm(s, ev.clientX, ev.clientY); return }
      // moved too far for a still hold → it can no longer arm a (touch) drag
      if (dist > tol) clearTimeout(s.timer)
      // moved far enough that it's a pan/scroll, not a tap → drop the select-on-release
      if (dist > tapTol) s.phase = 'pan'
    }
    const onUp = () => {
      const s = st.current
      if (s) {
        if (s.phase === 'drag') s.cbs.onDragEnd?.()
        else if (s.phase === 'pending') s.cbs.onTap?.() // released within tap slop → select
      }
      teardown()
    }
    // touch: a still hold arms the drag (mouse arms on move instead, above). Any movement past the
    // slop clears this timer in onMove, so if it fires the finger was held still → arm the drag.
    const timer = (canDrag && mode === 'touch')
      ? window.setTimeout(() => {
          const s = st.current
          if (!s || s.phase !== 'pending') return
          s.phase = 'drag'
          s.cbs.onHoldStart?.()
        }, delayMs)
      : 0
    st.current = { timer, sx: e.clientX, sy: e.clientY, phase: 'pending', mode, canDrag, cbs, onMove, onUp }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  useEffect(() => teardown, [])  // drop a live gesture if the host unmounts mid-press

  return { cancel, begin }
}
