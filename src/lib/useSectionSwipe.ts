import { useEffect, type RefObject } from 'react'

// Horizontal swipe to page between sections. Two consumers: the non-canvas surfaces
// (Checkliste ↔ Atemschutz ↔ Anwesenheit ↔ Mittel), and thin phone edge strips over the
// map/plan canvas.
//
// It uses NATIVE non-passive `touchmove` listeners (not React pointer handlers) on purpose: a
// horizontal drag over a scrollable child is a *scroll container*, and pointer events there get
// cancelled the instant the browser engages a gesture (so a pointerup/one-shot pointermove never
// completes the swipe). Touch events keep firing through the gesture and let us `preventDefault()`
// the horizontal drag while leaving vertical scrolling untouched. Touch events also have implicit
// capture (every touchmove fires on the touchstart element), so a thin edge strip still gets the
// whole gesture after the finger leaves it — no pointer capture needed.
const THRESHOLD = 56 // px of net horizontal travel before it pages
const DOMINANCE = 1.4 // |dx| must beat |dy| by this factor (a scroll stays a scroll)
const V_BAIL = 16 // once vertical travel dominates by this much, give up (let native scroll run)

export type SwipeOutcome = 'prev' | 'next' | 'bail' | null

/** Pure decision from a gesture delta: page prev/next, bail to native scroll, or nothing yet. */
export function swipeOutcome(dx: number, dy: number): SwipeOutcome {
  if (Math.abs(dy) > V_BAIL && Math.abs(dy) >= Math.abs(dx)) return 'bail'
  if (Math.abs(dx) >= THRESHOLD && Math.abs(dx) > Math.abs(dy) * DOMINANCE) return dx < 0 ? 'next' : 'prev'
  return null
}

/** Attach horizontal-swipe paging to `ref`'s element (touch only). Fires as soon as the gesture
 *  is unambiguously horizontal, preventing the browser from scrolling it sideways. */
export function useSectionSwipe(ref: RefObject<HTMLElement | null>, { enabled, onPrev, onNext }: {
  enabled: boolean
  onPrev: () => void
  onNext: () => void
}) {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: { x: number; y: number; fired: boolean } | null = null

    const onStart = (e: TouchEvent) => {
      start = null
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if ((e.target as Element).closest?.('input, textarea, select, [role="slider"], [data-noswipe]')) return
      start = { x: t.clientX, y: t.clientY, fired: false }
    }
    const onMove = (e: TouchEvent) => {
      if (!start || start.fired || e.touches.length !== 1) return
      const t = e.touches[0]
      const outcome = swipeOutcome(t.clientX - start.x, t.clientY - start.y)
      if (outcome === 'bail') { start = null; return }
      if (outcome === 'prev' || outcome === 'next') {
        start.fired = true
        e.preventDefault() // stop the browser treating the confirmed horizontal drag as a scroll
        ;(outcome === 'next' ? onNext : onPrev)()
      }
    }
    const end = () => { start = null }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [ref, enabled, onPrev, onNext])
}

/** The swipe-paged non-canvas sections, in nav order. Map & Plan are deliberately absent. */
export const SWIPE_SECTIONS = ['checklists', 'atemschutz', 'anwesenheit', 'mittel'] as const
export type SwipeSection = typeof SWIPE_SECTIONS[number]

/** Full nav order — used by the phone canvas EDGE-swipe (map/plan reachable too, from their edge). */
export const NAV_ORDER = ['map', 'plans', 'checklists', 'atemschutz', 'anwesenheit', 'mittel'] as const
export type NavSection = typeof NAV_ORDER[number]
