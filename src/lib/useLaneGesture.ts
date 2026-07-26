import { useRef, useState } from 'react'
import type { Shift } from '../types'
import { type DragEdge, type Span, dragShift, timeAtFraction } from './shifts'

/** past this the press is a drag, not a tap — a finger never holds perfectly still */
const DRAG_PX = 5
/** hold this long without moving and the person's sheet opens instead */
const HOLD_MS = 450

/** an in-progress sweep across empty lane: the stretch being drawn, not yet stored */
export interface LaneDraw { from: number; to: number }

/**
 * Direct manipulation of one person's lane in the Zeitplan.
 *
 * The paper form is filled in by drawing on the grid, so the screen works the same way instead of
 * hiding every edit behind a dialog:
 *   • drag across empty lane → plan exactly that stretch of time
 *   • tap a bar              → flip it between «geplant» and «fix» — the one thing about a shift
 *                              that changes constantly while the plan firms up
 *   • drag a bar             → move it; drag either END → stretch that side
 *   • press and hold         → open the person's sheet, which is also the ONLY place a shift is
 *                              deleted: a stray tap on a busy grid must never drop somebody's plan
 *
 * Everything snaps to the half-hour grid (lib/shifts). Live gestures are reported through
 * `preview` / `draw` so a bar follows the finger without a workspace write per pointer event —
 * only the release commits, which also keeps undo to one step per gesture.
 */
export function useLaneGesture(opts: {
  span: Span
  canEdit: boolean
  /** a sweep across empty lane finished — plan exactly that stretch */
  onCreate: (from: number, to: number) => void
  /** a bar was tapped — flip planned ⇄ fix */
  onToggle: (sh: Shift) => void
  /** a bar drag finished */
  onCommit: (sh: Shift) => void
  /** press-and-hold anywhere in the lane */
  onHold: () => void
  /** the shift covering a moment, if any — lets a tap ANYWHERE in the row's height hit the bar
   *  at that time, instead of only the ~28px the bar itself occupies */
  shiftAtTime: (t: number) => Shift | null
}) {
  const [preview, setPreview] = useState<Shift | null>(null)
  const [draw, setDraw] = useState<LaneDraw | null>(null)
  const drag = useRef<{
    shift: Shift | null; edge: DragEdge; startX: number; startAt: number
    rect: DOMRect; moved: boolean; held: boolean
  } | null>(null)
  const holdTimer = useRef<number | null>(null)

  const clearHold = () => {
    if (holdTimer.current != null) { clearTimeout(holdTimer.current); holdTimer.current = null }
  }

  /** fraction 0..1 of a clientX inside the lane; 0 when the lane has no measurable width or the
   *  event carries no coordinate, so a stray press can never produce an invalid time */
  const frac = (clientX: number, rect: DOMRect) =>
    (Number.isFinite(clientX) && rect.width > 0 ? (clientX - rect.left) / rect.width : 0)
  const timeAt = (clientX: number, rect: DOMRect) => timeAtFraction(frac(clientX, rect), opts.span)

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, sh: Shift | null, edge: DragEdge = 'move') => {
    if (!opts.canEdit) return
    const lane = e.currentTarget.closest('[data-lane]') as HTMLElement | null
    if (!lane) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const rect = lane.getBoundingClientRect()
    drag.current = {
      shift: sh, edge, startX: e.clientX, startAt: timeAt(e.clientX, rect), rect, moved: false, held: false,
    }
    clearHold()
    holdTimer.current = window.setTimeout(() => {
      const d = drag.current
      if (d && !d.moved) { d.held = true; setPreview(null); setDraw(null); opts.onHold() }
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.held) return
    const dx = e.clientX - d.startX
    if (!Number.isFinite(dx)) return
    if (!d.moved && Math.abs(dx) < DRAG_PX) return
    d.moved = true
    clearHold()
    if (d.shift) {
      const total = opts.span.to - opts.span.from
      setPreview(dragShift(d.shift, d.edge, (dx / Math.max(1, d.rect.width)) * total, opts.span))
    } else {
      // sweeping empty lane: the shift is whatever stretch the finger covered, either way round
      const at = timeAt(e.clientX, d.rect)
      setDraw({ from: Math.min(d.startAt, at), to: Math.max(d.startAt, at) })
    }
  }

  const end = (commit: boolean) => {
    const d = drag.current
    drag.current = null
    clearHold()
    const livePreview = preview
    const liveDraw = draw
    setPreview(null)
    setDraw(null)
    if (!d || d.held) return
    if (d.moved) {
      if (!commit) return
      if (d.shift && livePreview) opts.onCommit(livePreview)
      else if (!d.shift && liveDraw && liveDraw.to > liveDraw.from) opts.onCreate(liveDraw.from, liveDraw.to)
      return
    }
    if (!commit) return
    // A press that neither moved nor held is a tap. On a bar — or anywhere in the row's full
    // height at a time a bar covers, because a lane is 44px tall and a bar only ~28px, so a tap
    // a few pixels high used to land on dead ground — it flips planned ⇄ fix. On genuinely empty
    // lane it does nothing: planning is a sweep, so a mis-tap cannot litter the grid.
    const hit = d.shift ?? opts.shiftAtTime(d.startAt)
    if (hit) opts.onToggle(hit)
  }

  return {
    preview,
    draw,
    /** spread on the lane itself — an empty-lane press */
    laneProps: (canEdit: boolean) => (canEdit ? {
      'data-lane': true,
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => onPointerDown(e, null),
      onPointerMove,
      onPointerUp: () => end(true),
      onPointerCancel: () => end(false),
    } : { 'data-lane': true }),
    /** spread on a bar (or its resize handles) */
    barProps: (sh: Shift, edge: DragEdge = 'move') => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => onPointerDown(e, sh, edge),
      onPointerMove,
      onPointerUp: () => end(true),
      onPointerCancel: () => end(false),
    }),
  }
}
