import { useRef } from 'react'

// Horizontal swipe to page between adjacent NON-CANVAS sections (Checkliste ↔ Atemschutz ↔
// Anwesenheit ↔ Mittel). The map/plan surfaces are excluded — they own pan/zoom — so this only
// attaches where a horizontal drag has no other meaning. Touch/pen only (a desktop mouse uses the
// nav bar); a swipe must clearly dominate the vertical axis so it never hijacks a scroll; and it
// never starts on a control that itself reads horizontal drags (inputs, sliders).
const THRESHOLD = 64 // px of net horizontal travel before it counts as a page
const DOMINANCE = 1.7 // |dx| must beat |dy| by this factor (a scroll stays a scroll)

export function useSectionSwipe({ enabled, onPrev, onNext, capture }: {
  enabled: boolean
  onPrev: () => void
  onNext: () => void
  /** capture the pointer on arm — needed for thin edge strips, so a swipe that leaves the strip
   *  (onto the map) still delivers its move/up to this element. */
  capture?: boolean
}) {
  const start = useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = null
    if (!enabled || e.pointerType === 'mouse') return
    // don't arm on controls that consume horizontal drags themselves
    if ((e.target as Element).closest?.('input, textarea, select, [role="slider"], [data-noswipe]')) return
    start.current = { x: e.clientX, y: e.clientY }
    if (capture) try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current
    start.current = null
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return
    if (dx < 0) onNext() // swipe left → next section
    else onPrev() // swipe right → previous section
  }

  return { onPointerDown, onPointerUp, onPointerCancel: () => { start.current = null } }
}

/** The swipe-paged non-canvas sections, in nav order. Map & Plan are deliberately absent. */
export const SWIPE_SECTIONS = ['checklists', 'atemschutz', 'anwesenheit', 'mittel'] as const
export type SwipeSection = typeof SWIPE_SECTIONS[number]

/** Full nav order — used by the phone canvas EDGE-swipe (map/plan reachable too, from their edge). */
export const NAV_ORDER = ['map', 'plans', 'checklists', 'atemschutz', 'anwesenheit', 'mittel'] as const
export type NavSection = typeof NAV_ORDER[number]
