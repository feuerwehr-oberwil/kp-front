// The body drags of the Plan's ink, in pan mode: a single freehand stroke / Linie / Fläche
// (tap its fat hit-line in WbInkLayer), a single Absperrkreis (its ring or fill in WbCircleLayer),
// and a Linie's free-text label or end tag nudged to a per-line offset. One grammar for all three:
// a drag past the shared deadzone checkpoints ONCE, the release writes one audit event with the
// position it ended on. ⚠️ An Absperrkreis and a label move their own NODES while the finger is
// down (the chip drag's rule, useWbChipDrag) and write the board ONCE, on release – a write per move
// re-rendered the whole workspace (perf sweep 26.11.2026: 37 store writes for 40 moves). A stroke
// still writes per move: its decor (Länge, tags, grips) and an end pinned to an object follow the
// stored points, which a translate cannot preview.
// ⚠️ The press is the Lage's (duck sweep GESTURES.1, owner 17.11.2026 – the same rule as
// useWbChipDrag): on a body that is NOT selected a finger pans the board, a tap selects on release, and only a still hold (HOLD_DRAG_MS) lifts it; a selected body, and any
// mouse press, drags at once. A hose under the finger that pans the Gebäude no longer moves. Lifted out of the Whiteboard (sweep A.1, 25.10.2026),
// beside its siblings useWbChipDrag / useWbVertexEdit / useWbRotor; the drag refs are handed back
// for the stage dispatcher (Whiteboard · manipMove).

import { useRef } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool } from '../types'
import { DRAG_DEADZONE_PX, useHoldToDrag } from '../lib/useHoldToDrag'
import type { floorGeometry } from '../lib/whiteboard'
import { doorsOn, shiftStoreys } from '../lib/grundriss'
import type { useBoardDoc } from './useBoardDoc'

type FloorGeometry = ReturnType<typeof floorGeometry>
type BoardDoc = ReturnType<typeof useBoardDoc>

interface Args {
  tool: BoardTool
  /** a locked board selects (for the read-only panels) but never drags */
  readOnly: boolean
  annos: BoardAnno[]
  /** the selected anno – a press on it drags at once (the Lage's rule) */
  selId: string | null
  /** where the selected anno was tapped — the panel nudge anchors on it (Whiteboard · annoTap) */
  setAnnoTap: (tap: { id: string; x: number; y: number }) => void
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
  boardRef: React.RefObject<HTMLDivElement | null>
  /** the board's px size as drawn (the ink's px space) – a moved node is translated in it */
  sW: number
  sH: number
  boardPts: FloorGeometry['boardPts']
  moveRigid: FloorGeometry['moveRigid']
  localY: FloorGeometry['localY']
  mapY: FloorGeometry['mapY']
  /** the Gebäude stack: a stroke dragged onto another storey tile moves to that storey */
  stack: boolean
  floorAt: FloorGeometry['floorAt']
  /** the storeys the board draws (a stroke never moves onto one it does not) */
  floorsTTB: readonly number[]
  /** the storey tile a drag would drop onto (highlighted), null = its own */
  setDropFloor: (floor: number | null) => void
  pushPast: BoardDoc['pushPast']
  patch: BoardDoc['patch']
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
  /** a moved Wand's snap (usePlanDraft · snapMoveOf): the extra shift that lands one of its corners
   *  on a target, ring shown; `null` points clear the ring */
  snapMove: (ids: readonly string[], floor: number, moved: readonly (readonly [number, number])[] | null) => [number, number] | null
  /** useBoardGestures: pan the board from a press the body does not (yet) take, and stop it */
  panFrom: (e: React.PointerEvent) => void
  stopPan: () => void
}

/** Moves a node by (dx, dy) board px on top of where the board draws it; (0, 0) hands it back.
 *  An SVG group takes the `transform` attribute, an HTML node the `translate` property (both leave
 *  the node's own transform alone). */
function shift(n: Element, dx: number, dy: number) {
  const home = dx === 0 && dy === 0
  if (n instanceof SVGElement) {
    if (home) n.removeAttribute('transform')
    else n.setAttribute('transform', `translate(${dx} ${dy})`)
  } else if (n instanceof HTMLElement) n.style.translate = home ? '' : `${dx}px ${dy}px`
}

/** The Plan's ink body drags; see the file header. */
export function useWbBodyDrag({ tool, readOnly, annos, selId, setAnnoTap, setSelId, setSelIds, boardRef, sW, sH, boardPts, moveRigid, localY, mapY, stack, floorAt, floorsTTB, setDropFloor, pushPast, patch, emit, activeId, snapMove, panFrom, stopPan }: Args) {
  const hold = useHoldToDrag()
  /** The one press rule for every body (see the file header): `select` runs on the tap (or at
   *  once), `grab` sets up the drag from the press point. */
  const press = (e: React.PointerEvent, id: string, select: () => void, grab: ((sx: number, sy: number) => void) | null) => {
    const el = e.target as Element
    if (grab && (selId === id || e.pointerType === 'mouse')) {
      select(); grab(e.clientX, e.clientY)
      el.setPointerCapture?.(e.pointerId)
      return
    }
    const sx = e.clientX, sy = e.clientY
    panFrom(e)
    hold.begin(e, {
      onTap: select,
      onHoldStart: () => { stopPan(); select(); grab?.(sx, sy) },
    }, { mode: 'touch', canDrag: !!grab })
  }

  // drag a single selected freehand stroke (its original board-space vertices + the start point)
  // `bpts` keep each vertex's storey AS STORED (floorGeometry · boardPts); `last` is the stroke as
  // the latest sample wrote it, which is what the release reports. `orig` is the stroke as the
  // press found it and `f0` the storey tile under the press – a drag onto another tile shifts it there.
  const drawDrag = useRef<{ id: string; floor: number; sx: number; sy: number; bpts: BoardPoint[]; moved: boolean; last?: BoardPoint[]; orig: BoardAnno; f0: number } | null>(null)

  // --- single freehand-stroke select + drag (tap the fat hit-line in WbInkLayer, pan mode) ---
  const drawDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    // only the main button selects or drags (GESTURES.13): a right press on an object does nothing
    if (e.button > 0) { e.stopPropagation(); return }
    // locked (BoardAnno.locked): the ink is click-through, so a big Sektor-Fläche stops swallowing
    // the taps meant for the work on top of it. NOT stopPropagation'd — the tap goes on to the
    // stage and does what an empty-canvas tap does, which is the map's behaviour too. The lock
    // chip over it is the only tap target it still has.
    if (annos.find((x) => x.id === id)?.locked) return
    e.stopPropagation()
    // remember WHERE it was tapped, paired with the id — the panel nudge anchors on it for a stroke
    // too big for its bounds to mean anything (lib/panelNudge · panelNudgeSelection). Client px,
    // the same space the nudge's box is built in.
    const tap = { id, x: e.clientX, y: e.clientY }
    const select = () => { setAnnoTap(tap); setSelId(id); setSelIds([]) }
    // a locked board SELECTS (the read-only DrawEditor: Länge, Leitung-Nr., the Trupp on it) but
    // never drags — the Lage's parity (RBAC audit 22.10.2026)
    const a = annos.find((x) => x.id === id)
    const canDrag = !readOnly && !!a && (a.kind === 'draw' || a.kind === 'area')
    press(e, id, select, canDrag ? (sx, sy) => {
      // snapshot the vertices in board-space (y mapped to the stacked board), so the delta is always
      // applied to the original geometry — no drift across re-renders (mirrors the group-move math)
      const rect = boardRef.current?.getBoundingClientRect()
      const f0 = stack && rect?.height ? floorAt((sy - rect.top) / rect.height) : a.floor ?? 0
      drawDrag.current = { id, floor: a.floor ?? 0, sx, sy, bpts: boardPts(a.pts ?? [], a.floor ?? 0), moved: false, orig: a, f0 }
    } : null)
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
    let ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    const a = annos.find((x) => x.id === st.id)
    // On the Gebäude stack the stroke goes to the storey under the pointer (27.10.2026): every
    // storey it is on shifts by the same step, and the tile jump comes off the translation so it
    // lands where it was dropped on the new tile. A docked stroke, or one that would leave the
    // stack, stays on its storeys (shiftStoreys → null).
    const f1 = stack ? floorAt((e.clientY - rect.top) / rect.height) : st.f0
    const docked = !!(st.orig.startAttachment || st.orig.endAttachment)
    const across = f1 !== st.f0 && !docked ? shiftStoreys(st.orig, f1 - st.f0, floorsTTB) : null
    const home = across?.floor ?? st.floor
    const bpts = across ? boardPts(across.pts ?? [], home) : st.bpts
    const jump = across ? mapY(f1, 0) - mapY(st.f0, 0) : 0
    // a Wand lands on what it is moved next to (round 3, 27.10.2026): the whole wall shifts so its
    // nearest corner sits on a Wand, a Fläche edge or the outline of the storey it goes to
    const snap = st.orig.role === 'wand' && stack
      ? snapMove([st.id], home, bpts.filter((p) => (p[2] ?? home) === home).map(([x, by]) => [x + ndx, by + ndy - jump]))
      : null
    if (snap) { ndx += snap[0]; ndy += snap[1] }
    // ⚠️ ONE body: the stroke keeps its shape at a tile's edge (floorGeometry · moveRigid) — the
    // per-vertex clamp flattened a Leitung onto the tile's rim in the field (23.09.2026)
    const pts = moveRigid(bpts, home, (x, by) => [x + ndx, by + ndy - jump], (i) => (
      (i === 0 && a?.startAttachment) || (i === st.bpts.length - 1 && a?.endAttachment)
        ? a?.pts?.[i] ?? [st.bpts[i][0], localY(st.bpts[i][1], st.bpts[i][2] ?? st.floor), st.bpts[i][2] ?? st.floor]
        : null))
    st.last = pts
    setDropFloor(across ? f1 : null)
    patch(st.id, { pts, ...((a?.floor ?? 0) !== home ? { floor: home } : null) })
  }
  const drawUp = () => {
    const st = drawDrag.current; drawDrag.current = null
    if (!st?.moved) return
    setDropFloor(null)
    if (st.orig.role === 'wand') snapMove([st.id], st.floor, null) // the ring goes with the hand
    // ⚠️ …WITH the points. A stroke's position IS its points, and this was the one board.move that
    // named none — an unfoldable payload, so the replay left the line where the last snapshot had
    // it while every other plan drag now moves (lib/replay · board.move). …and its storey, which a
    // drop onto another tile changed.
    const a = annos.find((x) => x.id === st.id)
    emit('board.move', { id: st.id, pts: st.last ?? a?.pts, ...(stack ? { floor: a?.floor ?? 0 } : null), planId: activeId })
    // the Durchgänge that rode along with a Wand (lib/grundriss · carryDoors) – their seat, for the replay
    doorsOn(annos, [st.id]).forEach((d) => emit('board.edit', { id: d.id, patch: { x: d.x, y: d.y, floor: d.floor, rotation: d.rotation }, planId: activeId }))
  }

  // --- single Absperrkreis select + move (tap its ring/fill in WbCircleLayer, pan mode) ---
  // ⚠️ A DELTA on the centre, not the chip drag's jump-to-the-finger (chipMove): a cordon is
  // grabbed anywhere on its face, and moving the centre to the grab point would shift the ring
  // out from under the hand. Same grammar as the stroke body-drag above — deadzone, one
  // checkpoint per drag, one board.move on release.
  // Off the stack the drag translates every node tagged `data-circle-id` (the ring, its radius
  // readout, its radius grip) and writes once on release. On the Gebäude stack it writes per move
  // (`live`): the ring is clipped to its storey's section, and a translated clip would move along.
  const circleDrag = useRef<{
    id: string; sx: number; sy: number; x0: number; by0: number; floor: number; moved: boolean
    /** the floor as stored (absent on a flat sheet) – what the audit row names */
    storedFloor: number | undefined
    live: boolean; nodes: Element[]
    /** where the finger has put the centre so far */
    last: { x: number; y: number } | null
  } | null>(null)
  const circleDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'pan') return
    // only the main button selects or drags (GESTURES.13): a right press on an object does nothing
    if (e.button > 0) { e.stopPropagation(); return }
    const a = annos.find((x) => x.id === id)
    if (!a || a.locked) return // locked ink is click-through; the LockChip is its only door
    e.stopPropagation()
    const tap = { id, x: e.clientX, y: e.clientY }
    const select = () => { setAnnoTap(tap); setSelId(id); setSelIds([]) }
    // selected for its read-only panel, never moved (see drawDown)
    press(e, id, select, readOnly ? null : (sx, sy) => {
      circleDrag.current = { id, sx, sy, x0: a.x ?? 0, by0: mapY(a.floor, a.y ?? 0), floor: a.floor ?? 0, storedFloor: a.floor, moved: false, live: stack, nodes: [], last: null }
    })
  }
  const circleMove = (e: React.PointerEvent) => {
    const st = circleDrag.current; if (!st) return
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < DRAG_DEADZONE_PX) return
      if (st.live) pushPast() // one checkpoint per drag (off the stack: on release)
      // collected here, not on the press: the radius grip mounts with the selection the press made
      else st.nodes = [...(boardRef.current?.querySelectorAll('[data-circle-id]') ?? [])].filter((n) => n.getAttribute('data-circle-id') === st.id)
      st.moved = true
    }
    const ndx = (e.clientX - st.sx) / rect.width, ndy = (e.clientY - st.sy) / rect.height
    // the storey stays put (a cordon belongs to the sheet it was drawn on): board-global y is
    // re-localised back into that same tile, exactly as the stroke drag does
    const last = { x: st.x0 + ndx, y: localY(st.by0 + ndy, st.floor) }
    st.last = last
    if (st.live) { patch(st.id, last); return }
    const dx = (last.x - st.x0) * sW, dy = (mapY(st.floor, last.y) - st.by0) * sH
    st.nodes.forEach((n) => shift(n, dx, dy))
  }
  const circleUp = () => {
    const st = circleDrag.current; circleDrag.current = null
    if (!st?.moved || !st.last) return
    if (!st.live) {
      // the board takes the circle over from the nodes in the same frame
      st.nodes.forEach((n) => shift(n, 0, 0))
      pushPast() // the drag's one step
      patch(st.id, st.last)
    }
    emit('board.move', { id: st.id, ...st.last, floor: st.storedFloor, planId: activeId })
  }

  // --- drag a Linie's free-text label to a per-line offset (normalized board fractions, so it
  // tracks under zoom), mirroring the Lage map's moveLabel. The label's own element moves while the
  // finger is down; the release writes the offset as one undo step and emits it. ---
  const labelDrag = useRef<{ id: string; sx: number; sy: number; dx0: number; dy0: number; moved: boolean; el: HTMLElement; last: { labelDx: number; labelDy: number } | null } | null>(null)
  const labelDown = (e: React.PointerEvent, id: string, dx0: number, dy0: number) => {
    // a second finger is the pinch's (useBoardGestures · trackDown ends the drag through labelEnd)
    if (tool !== 'pan' || readOnly || !e.isPrimary) return
    // only the main button selects or drags (GESTURES.13): a right press on an object does nothing
    if (e.button > 0) { e.stopPropagation(); return }
    e.stopPropagation()
    // capture on the STABLE handler element (the label span), NOT e.target (an inner text <div>
    // that re-renders as the label moves) — a lost capture sent the moves to the stage, which
    // panned the board and made the label jump unpredictably
    const el = e.currentTarget as HTMLElement, pid = e.pointerId
    const grab = (sx: number, sy: number) => {
      el.setPointerCapture?.(pid)
      labelDrag.current = { id, sx, sy, dx0, dy0, moved: false, el, last: null }
    }
    // the label belongs to its line: the press rule is the line's (see the file header)
    if (selId === id || e.pointerType === 'mouse') { setSelId(id); grab(e.clientX, e.clientY); return }
    const sx = e.clientX, sy = e.clientY
    panFrom(e)
    hold.begin(e, {
      onTap: () => setSelId(id),
      // the hold lifted it: the label's own element takes the pointer back from the board
      onHoldStart: () => { stopPan(); setSelId(id); grab(sx, sy) },
    }, { mode: 'touch' })
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
      st.moved = true
    }
    const ndx = st.dx0 + (e.clientX - st.sx) / rect.width
    const ndy = st.dy0 + (e.clientY - st.sy) / rect.height
    st.last = { labelDx: ndx, labelDy: ndy }
    shift(st.el, (ndx - st.dx0) * sW, (ndy - st.dy0) * sH)
  }
  const labelUp = (e: React.PointerEvent) => {
    if (!labelDrag.current) return
    e.stopPropagation()
    labelEnd()
  }
  /** Ends a label drag where it lies – its release, and the stage's (Whiteboard · manipUp) when a
   *  second finger starts a pinch. */
  const labelEnd = () => {
    const st = labelDrag.current; labelDrag.current = null
    if (!st?.moved || !st.last) return
    shift(st.el, 0, 0)
    pushPast() // the drag's one step
    patch(st.id, st.last)
    // …with the offsets it dragged: a `board.edit` naming no patch folds to nothing (lib/replay),
    // so the nudged label snapped back on every scrub between snapshots.
    emit('board.edit', { id: st.id, planId: activeId, patch: st.last })
  }

  return { drawDrag, drawDown, drawMove, drawUp, circleDrag, circleDown, circleMove, circleUp, labelDown, labelMove, labelUp, labelEnd }
}
