// The body drags of the Plan's ink, in pan mode: a single freehand stroke / Linie / Fläche
// (tap its fat hit-line in WbInkLayer), a single Absperrkreis (its ring or fill in WbCircleLayer),
// and a Linie's free-text label or end tag nudged to a per-line offset. One grammar for all three:
// the press selects, a drag past the shared deadzone checkpoints ONCE, the release writes one
// audit event with the position it ended on. Lifted out of the Whiteboard (sweep A.1, 25.10.2026),
// beside its siblings useWbChipDrag / useWbVertexEdit / useWbRotor; the drag refs are handed back
// for the stage dispatcher (Whiteboard · manipMove).

import { useRef } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool } from '../types'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import type { floorGeometry } from '../lib/whiteboard'
import type { useBoardDoc } from './useBoardDoc'

type FloorGeometry = ReturnType<typeof floorGeometry>
type BoardDoc = ReturnType<typeof useBoardDoc>

interface Args {
  tool: BoardTool
  /** a locked board selects (for the read-only panels) but never drags */
  readOnly: boolean
  annos: BoardAnno[]
  /** where the selected anno was tapped — the panel nudge anchors on it (Whiteboard · annoTap) */
  setAnnoTap: (tap: { id: string; x: number; y: number }) => void
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
  boardRef: React.RefObject<HTMLDivElement | null>
  boardPts: FloorGeometry['boardPts']
  moveRigid: FloorGeometry['moveRigid']
  localY: FloorGeometry['localY']
  mapY: FloorGeometry['mapY']
  pushPast: BoardDoc['pushPast']
  patch: BoardDoc['patch']
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
}

/** The Plan's ink body drags; see the file header. */
export function useWbBodyDrag({ tool, readOnly, annos, setAnnoTap, setSelId, setSelIds, boardRef, boardPts, moveRigid, localY, mapY, pushPast, patch, emit, activeId }: Args) {
  // drag a single selected freehand stroke (its original board-space vertices + the start point)
  // `bpts` keep each vertex's storey AS STORED (floorGeometry · boardPts); `last` is the stroke as
  // the latest sample wrote it, which is what the release reports
  const drawDrag = useRef<{ id: string; floor: number; sx: number; sy: number; bpts: BoardPoint[]; moved: boolean; last?: BoardPoint[] } | null>(null)

  // --- single freehand-stroke select + drag (tap the fat hit-line in WbInkLayer, pan mode) ---
  const drawDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    // locked (BoardAnno.locked): the ink is click-through, so a big Sektor-Fläche stops swallowing
    // the taps meant for the work on top of it. NOT stopPropagation'd — the tap goes on to the
    // stage and does what an empty-canvas tap does, which is the map's behaviour too. The lock
    // chip over it is the only tap target it still has.
    if (annos.find((x) => x.id === id)?.locked) return
    e.stopPropagation()
    // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for a stroke
    // too big for its bounds to mean anything (lib/panelNudge · panelNudgeSelection). Client px,
    // the same space the nudge's box is built in.
    setAnnoTap({ id, x: e.clientX, y: e.clientY })
    setSelId(id); setSelIds([])
    // a locked board SELECTS (the read-only DrawEditor: Länge, Leitung-Nr., the Trupp on it) but
    // never drags — the Lage's parity (RBAC audit 22.10.2026)
    if (readOnly) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const a = annos.find((x) => x.id === id); if (!a || (a.kind !== 'draw' && a.kind !== 'area')) return
    // snapshot the vertices in board-space (y mapped to the stacked board), so the delta is always
    // applied to the original geometry — no drift across re-renders (mirrors the group-move math)
    drawDrag.current = { id, floor: a.floor ?? 0, sx: e.clientX, sy: e.clientY, bpts: boardPts(a.pts ?? [], a.floor ?? 0), moved: false }
  }
  const drawMove = (e: React.PointerEvent) => {
    const st = drawDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    // tap-vs-drag threshold: a finger never lands perfectly still, so without this a plain TAP on
    // a selected area/line nudged it (and stamped an undo step). Inside DRAG_DEADZONE_PX it's a
    // tap → no move, so tapping just keeps the selection (and tapping empty space still
    // deselects via the stage). Same deadzone as every other drag on both surfaces.
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_DEADZONE_PX) return
      pushPast(); st.moved = true // one checkpoint per drag
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    const a = annos.find((x) => x.id === st.id)
    // ⚠️ ONE body: the stroke keeps its shape at a tile's edge (floorGeometry · moveRigid) — the
    // per-vertex clamp flattened a Leitung onto the tile's rim in the field (23.09.2026)
    const pts = moveRigid(st.bpts, st.floor, (x, by) => [x + ndx, by + ndy], (i) => (
      (i === 0 && a?.startAttachment) || (i === st.bpts.length - 1 && a?.endAttachment)
        ? a?.pts?.[i] ?? [st.bpts[i][0], localY(st.bpts[i][1], st.bpts[i][2] ?? st.floor), st.bpts[i][2] ?? st.floor]
        : null))
    st.last = pts
    patch(st.id, { pts })
  }
  const drawUp = () => {
    const st = drawDrag.current; drawDrag.current = null
    if (!st?.moved) return
    // ⚠️ …WITH the points. A stroke's position IS its points, and this was the one board.move that
    // named none — an unfoldable payload, so the replay left the line where the last snapshot had
    // it while every other plan drag now moves (lib/replay · board.move).
    emit('board.move', { id: st.id, pts: st.last ?? annos.find((x) => x.id === st.id)?.pts, planId: activeId })
  }

  // --- single Absperrkreis select + move (tap its ring/fill in WbCircleLayer, pan mode) ---
  // ⚠️ A DELTA on the centre, not the chip drag's jump-to-the-finger (chipMove): a cordon is
  // grabbed anywhere on its face, and moving the centre to the grab point would shift the ring
  // out from under the hand. Same grammar as the stroke body-drag above — deadzone, one
  // checkpoint per drag, one board.move on release.
  const circleDrag = useRef<{ id: string; sx: number; sy: number; x0: number; by0: number; floor: number; moved: boolean } | null>(null)
  const circleDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    const a = annos.find((x) => x.id === id)
    if (!a || a.locked) return // locked ink is click-through; the LockChip is its only door
    e.stopPropagation()
    setAnnoTap({ id, x: e.clientX, y: e.clientY })
    setSelId(id); setSelIds([])
    if (readOnly) return // selected for its read-only panel, never moved (see drawDown)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    circleDrag.current = { id, sx: e.clientX, sy: e.clientY, x0: a.x ?? 0, by0: mapY(a.floor, a.y ?? 0), floor: a.floor ?? 0, moved: false }
  }
  const circleMove = (e: React.PointerEvent) => {
    const st = circleDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_DEADZONE_PX) return
      pushPast(); st.moved = true // one checkpoint per drag
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    // the storey stays put (a cordon belongs to the sheet it was drawn on): board-global y is
    // re-localised back into that same tile, exactly as the stroke drag does
    patch(st.id, { x: st.x0 + ndx, y: localY(st.by0 + ndy, st.floor) })
  }
  const circleUp = () => {
    const st = circleDrag.current; circleDrag.current = null
    if (!st?.moved) return
    const a = annos.find((x) => x.id === st.id)
    emit('board.move', { id: st.id, x: a?.x, y: a?.y, floor: a?.floor, planId: activeId })
  }

  // --- drag a Linie's free-text label to a per-line offset (normalized board fractions, so it
  // tracks under zoom), mirroring the Lage map's moveLabel. Folds into one undo step like the
  // stroke move: snapshot on first move, stream, emit on release. ---
  const labelDrag = useRef<{ id: string; sx: number; sy: number; dx0: number; dy0: number; moved: boolean; which: 'label' | 'end' } | null>(null)
  const labelDown = (e: React.PointerEvent, id: string, dx0: number, dy0: number, which: 'label' | 'end' = 'label') => {
    if (tool !== 'pan' || readOnly) return
    e.stopPropagation()
    // capture on the STABLE handler element (the label span), NOT e.target (an inner text <div>
    // that re-renders as the label moves) — a lost capture sent the moves to the stage, which
    // panned the board and made the label jump unpredictably
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    setSelId(id)
    labelDrag.current = { id, sx: e.clientX, sy: e.clientY, dx0, dy0, moved: false, which }
  }
  const labelMove = (e: React.PointerEvent) => {
    const st = labelDrag.current; if (!st) return
    // setPointerCapture retargets but does NOT stop bubbling — without this stop, every label
    // move ALSO bubbles to the canvas stageMove → manipMove and drives any live area/vertex drag,
    // so dragging the label "moved everything". Stop it here (after the ours-check, before the
    // threshold return so sub-threshold frames don't leak to the stage either).
    e.stopPropagation()
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 6) return // tap, not a drag
      pushPast(); st.moved = true
    }
    const ndx = st.dx0 + (e.clientX - st.sx) / rect.width
    const ndy = st.dy0 + (e.clientY - st.sy) / rect.height
    patch(st.id, st.which === 'end' ? { endDx: ndx, endDy: ndy } : { labelDx: ndx, labelDy: ndy })
  }
  const labelUp = (e: React.PointerEvent) => {
    if (!labelDrag.current) return
    e.stopPropagation()
    const st = labelDrag.current; labelDrag.current = null
    if (!st?.moved) return
    // …with the offsets it dragged: a `board.edit` naming no patch folds to nothing (lib/replay),
    // so the nudged label snapped back on every scrub between snapshots.
    const a = annos.find((x) => x.id === st.id)
    emit('board.edit', { id: st.id, planId: activeId,
      patch: st.which === 'end' ? { endDx: a?.endDx, endDy: a?.endDy } : { labelDx: a?.labelDx, labelDy: a?.labelDy } })
  }

  return { drawDrag, drawDown, drawMove, drawUp, circleDrag, circleDown, circleMove, circleUp, labelDown, labelMove, labelUp }
}
