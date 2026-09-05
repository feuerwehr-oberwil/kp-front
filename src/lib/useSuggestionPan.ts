import { useRef, type MouseEvent, type PointerEvent } from 'react'

const PAN_TOL_PX = 8 // same travel tolerance as holdTooltip

type Pan = {
  id: number
  x: number
  y: number
  left: number
  dragging: boolean
}

/** Drag a suggestion strip horizontally, with `touch-action: pan-y` on its scroll container.
 * Vertical gestures remain native; mouse wheels/trackpads retain ordinary overflow scrolling.
 * Never cancel pointer events: a still tap must retain its button and the editor's focus. */
export function useSuggestionPan() {
  const pan = useRef<Pan | null>(null)
  const moved = useRef(false)

  const track = (e: PointerEvent<HTMLDivElement>) => {
    const start = pan.current
    if (!start || start.id !== e.pointerId) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.hypot(dx, dy) > PAN_TOL_PX) moved.current = true
    if (Math.abs(dx) > PAN_TOL_PX && Math.abs(dx) > Math.abs(dy)) start.dragging = true
    if (!start.dragging) return
    const row = e.currentTarget
    row.scrollLeft = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, start.left - dx))
  }

  return {
    onPointerDownCapture: (e: PointerEvent<HTMLDivElement>) => {
      if (pan.current || e.button !== 0) return
      moved.current = false
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
      pan.current = {
        id: e.pointerId, x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft,
        dragging: false,
      }
    },
    onPointerMoveCapture: track,
    onPointerUpCapture: (e: PointerEvent<HTMLDivElement>) => {
      if (pan.current?.id !== e.pointerId) return
      track(e)
      pan.current = null
    },
    onPointerCancelCapture: (e: PointerEvent<HTMLDivElement>) => {
      if (pan.current?.id !== e.pointerId) return
      moved.current = true
      pan.current = null
    },
    onClickCapture: (e: MouseEvent<HTMLDivElement>) => {
      // Keyboard/assistive activation is independent of the previous pointer gesture.
      if (!moved.current || e.detail === 0) return
      moved.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
