// The selection bar's transform on the Plan (components/SelectionBar): ONE writer for every
// selection this surface has — a Mehrfach group, a single Linie/Fläche/Absperrkreis, a single Form
// — moved by ✥ and turned by ⟳, dragged or armed and taken on the sheet (lib/useArmedTransform),
// plus «Fertig». Lifted out of the Whiteboard (sweep A.1, 25.10.2026); the Karte's twin is the
// same bar over useMapActions. docs/tactical-objects.md.

import { useRef, useState } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool } from '../types'
import { centroid, rotateAround, turnedBy } from '../lib/selectionTransform'
import { useArmedTransform } from '../lib/useArmedTransform'
import { beginSheetPeek, endSheetPeek } from '../lib/sheetPeek'
import type { floorGeometry } from '../lib/whiteboard'
import { doorsOn, shiftStoreys } from '../lib/grundriss'
import type { useBoardDoc } from './useBoardDoc'

type FloorGeometry = ReturnType<typeof floorGeometry>
type BoardDoc = ReturnType<typeof useBoardDoc>

interface Args {
  tool: BoardTool
  readOnly: boolean
  /** «Karte verknüpfen» is armed: no bar while references are being set */
  georefArmed: boolean
  annos: BoardAnno[]
  /** what is selected: the Mehrfach group, the single Linie/Fläche/Absperrkreis as an EDIT target
   *  (Whiteboard · editDraw — absent when read-only), the single Form */
  selIds: string[]
  editDraw?: BoardAnno
  selShape?: BoardAnno
  /** «Fertig» closes the selection and every sheet that was open for it */
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
  setNotePanelId: (id: string | null) => void
  setEditId: (id: string | null) => void
  setAnnoTap: (tap: null) => void
  sW: number
  sH: number
  mapY: FloorGeometry['mapY']
  localY: FloorGeometry['localY']
  boardPts: FloorGeometry['boardPts']
  moveRigid: FloorGeometry['moveRigid']
  /** the Gebäude stack: a selection moved onto another storey tile goes to that storey */
  stack: boolean
  floorAt: FloorGeometry['floorAt']
  floorsTTB: readonly number[]
  /** the storey tile the move would drop onto (highlighted), null = its own */
  setDropFloor: (floor: number | null) => void
  /** the moved Wände's snap (usePlanDraft · snapMoveOf): the extra shift that lands one of their
   *  corners on a target, ring shown; `null` points clear the ring */
  snapMove: (ids: readonly string[], floor: number, moved: readonly (readonly [number, number])[] | null) => [number, number] | null
  pushPast: BoardDoc['pushPast']
  set: (next: BoardAnno[]) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
  boardRef: React.RefObject<HTMLDivElement | null>
  canvasRef: React.RefObject<HTMLDivElement | null>
  onStepEnd?: () => void
}

/** The Plan's selection-bar transform; see the file header. */
export function useWbSelectionBar({
  tool, readOnly, georefArmed, annos, selIds, editDraw, selShape, setSelId, setSelIds, setNotePanelId, setEditId, setAnnoTap,
  sW, sH, mapY, localY, boardPts, moveRigid, stack, floorAt, floorsTTB, setDropFloor, snapMove, pushPast, set, emit, activeId, boardRef, canvasRef, onStepEnd,
}: Args) {
  // The selection bar's drag origin: the original board-space geometry and bearings of every
  // selected anno, plus the centre a turn pivots about. Pan/pinch/marquee refs live in
  // useBoardGestures.
  type GrpOrig = { id: string; floor: number; rot?: number; rot2?: number; bx?: number; by?: number; bpts?: BoardPoint[]; orig: BoardAnno }
  const groupOrig = useRef<GrpOrig[]>([])
  /** the selection's centre (board space) as the gesture started – the storey it lands on is the tile under it */
  const moveCentre = useRef<{ x: number; y: number } | null>(null)
  const barRotCentre = useRef<{ x: number; y: number } | null>(null)
  // --- the selection bar's transform target (components/SelectionBar) ------------------------
  // ONE writer for every selection this surface has: a Mehrfach group, a single Linie/Fläche/
  // Absperrkreis, a single Form. The bar hands over a client-px delta or a turn in degrees; what
  // happens to each member depends only on whether it is ink (pts) or a point anno (x/y), never
  // on how many are selected. That is what retired the plan's group pill and the map's hub in
  // the same move.
  const barIds: string[] = selIds.length > 1 ? selIds
    : editDraw ? [editDraw.id]
    : selShape && !readOnly ? [selShape.id]
    : []
  const barActive = barIds.length > 0
    && (selIds.length > 1 ? tool === 'pan' || tool === 'lasso' : tool === 'pan')
    && !readOnly && !georefArmed
  /** The selection's centre in board-normalized space — the shared resolver (lib/selectionTransform),
   *  and the reason a line, a Fläche and an Absperrkreis have one at all: rotDown reads the
   *  `.wb-anno` chip's bounding box, and ink has no chip. */
  const barCentre = (() => {
    if (!barActive) return null
    const c = centroid([
      ...annos.flatMap((a): [number, number][] => {
        if (!barIds.includes(a.id)) return []
        // ink is its points; everything else (chip, Form, Absperrkreis, Notiz) is its anchor
        if (a.pts?.length) return a.pts.map(([x, y, floor]) => [x, mapY(floor ?? a.floor, y)])
        return [[a.x ?? 0, mapY(a.floor, a.y ?? 0)]]
      }),
    ])
    return c ? { x: c[0], y: c[1] } : null
  })()
  /** snapshot every member's ORIGINAL board-space geometry, so each frame's delta is applied to
   *  the start position and never compounds across re-renders */
  const barSnapshot = () => {
    pushPast() // one checkpoint for the whole gesture
    moveCentre.current = barCentre
    groupOrig.current = annos.filter((a) => barIds.includes(a.id)).map((a) =>
      a.pts
        ? { id: a.id, floor: a.floor ?? 0, rot: a.rotation, rot2: a.rotation2, bpts: boardPts(a.pts, a.floor ?? 0), orig: a }
        : { id: a.id, floor: a.floor ?? 0, rot: a.rotation, rot2: a.rotation2, bx: a.x ?? 0, by: mapY(a.floor, a.y ?? 0), orig: a },
    )
  }
  /** The storey step a MOVE frame takes on the Gebäude stack (27.10.2026): the selection goes to
   *  the tile its centre is dragged onto, every member by the same step (lib/grundriss ·
   *  shiftStoreys), with the tile jump taken off the translation. Null – it stays on its storeys –
   *  off the stack, for a turn, for a docked line, or when any member would leave the stack. */
  const crossing = (t: { ndy: number; deg: number }) => {
    const c = moveCentre.current
    if (!stack || t.deg || !c) return null
    const f0 = floorAt(c.y), f1 = floorAt(c.y + t.ndy)
    if (f0 === f1) return null
    const shifted = new Map<string, BoardAnno>()
    for (const o of groupOrig.current) {
      const s = o.orig.startAttachment || o.orig.endAttachment ? null : shiftStoreys(o.orig, f1 - f0, floorsTTB)
      if (!s) return null
      shifted.set(o.id, s)
    }
    return { f1, jump: mapY(f1, 0) - mapY(f0, 0), shifted }
  }
  /** a member's storey fields as `src` has them, written only where they differ from `a` */
  const storeyOf = (src: BoardAnno, a: BoardAnno): Partial<BoardAnno> => {
    const out: Partial<BoardAnno> = {}
    if ((src.floor ?? 0) !== (a.floor ?? 0)) out.floor = src.floor
    if (src.floorFrom !== a.floorFrom) out.floorFrom = src.floorFrom
    if (src.floorTo !== a.floorTo) out.floorTo = src.floorTo
    return out
  }
  /** A MOVE frame holding Wände lands them on what they are moved next to (round 3, 27.10.2026):
   *  the extra shift that puts the nearest Wand corner of the selection on a Wand, a Fläche edge
   *  or the outline of the storey under the selection's centre – only corners on that storey
   *  count. Null for a turn, off the stack, and for a selection without a Wand. */
  const snapWalls = (t: { ndx: number; ndy: number; deg: number }, across: ReturnType<typeof crossing>) => {
    const c = moveCentre.current
    if (t.deg || !stack || !c) return null
    const walls = groupOrig.current.filter((o) => o.orig.role === 'wand' && o.bpts)
    if (!walls.length) return null
    const floor = across?.f1 ?? floorAt(c.y + t.ndy)
    const jump = across?.jump ?? 0
    const moved = walls.flatMap((o) => {
      const src = across?.shifted.get(o.id) ?? o.orig
      const home = src.floor ?? 0
      return (across ? boardPts(src.pts ?? [], home) : o.bpts ?? [])
        .filter((p) => (p[2] ?? home) === floor)
        .map(([x, by]): [number, number] => [x + t.ndx, by + t.ndy - jump])
    })
    return snapMove(barIds, floor, moved)
  }
  /** write one frame of the gesture: `t` moves in board fractions, `deg` turns about `barCentre`.
   *  Members stay on their own storey unless a move drops them onto another tile (`crossing`), and
   *  an ATTACHED line end stays pinned to its target — the same rules the single-object body drag
   *  follows. Returns what it wrote, so the release reports the frame it actually ended on. */
  const barApply = (frame: { ndx: number; ndy: number; deg: number }, centre: { x: number; y: number } | null): BoardAnno[] => {
    // x and y are fractions of DIFFERENT edges, so a turn has to happen in px proportions
    const xScale = (sW || 1) / (sH || 1)
    const turn = (x: number, by: number): [number, number] => (frame.deg && centre
      ? rotateAround([x, by], [centre.x, centre.y], frame.deg, { xScale })
      : [x, by])
    const across = crossing(frame)
    setDropFloor(across?.f1 ?? null)
    const jump = across?.jump ?? 0
    const snap = snapWalls(frame, across)
    const t = snap ? { ...frame, ndx: frame.ndx + snap[0], ndy: frame.ndy + snap[1] } : frame
    const next = annos.map((a) => {
      const o = groupOrig.current.find((g) => g.id === a.id); if (!o) return a
      const src = across?.shifted.get(a.id) ?? o.orig
      const home = src.floor ?? 0
      const turned = t.deg
        ? { ...(o.rot !== undefined ? { rotation: turnedBy(o.rot, t.deg) } : null), ...(o.rot2 !== undefined ? { rotation2: turnedBy(o.rot2, t.deg) } : null) }
        : null
      // ⚠️ each stroke is ONE body, turned and moved whole and kept whole at its tile's edge
      // (floorGeometry · moveRigid) — the same writer as the stroke body drag above
      const bpts = o.bpts && (across ? boardPts(src.pts ?? [], home) : o.bpts)
      if (bpts) return { ...a, ...turned, ...storeyOf(src, a), pts: moveRigid(bpts, home, (x, by) => { const [rx, ry] = turn(x, by); return [rx + t.ndx, ry + t.ndy - jump] }, (i) => (
        (i === 0 && a.startAttachment) || (i === bpts.length - 1 && a.endAttachment)
          ? a.pts?.[i] ?? [bpts[i][0], localY(bpts[i][1], bpts[i][2] ?? o.floor), bpts[i][2] ?? o.floor]
          : null)) }
      const [rx, ry] = turn(o.bx ?? 0, o.by ?? 0)
      return { ...a, ...turned, ...storeyOf(src, a), x: rx + t.ndx, y: localY(ry + t.ndy - jump, o.floor) }
    })
    set(next)
    return next
  }
  /** One `board.move` per member, carrying its POSITION — `pts` for ink, whose position IS its
   *  points (the same payload `drawUp` sends). ⚠️ It sent x/y/floor for everything, which a stroke
   *  does not have: the event named no position at all and the replay folded nothing (prod
   *  23.09.2026 19:00:55). Read off the frame the gesture ended on, not off the last render. */
  const barCommit = (written: BoardAnno[]) => {
    setDropFloor(null)
    snapMove(barIds, 0, null) // the ring goes with the hand
    written.filter((a) => barIds.includes(a.id))
      .forEach((a) => emit('board.move', a.pts
        ? { id: a.id, pts: a.pts, ...(stack ? { floor: a.floor ?? 0 } : null), planId: activeId }
        : { id: a.id, x: a.x, y: a.y, floor: a.floor, ...(stack && a.kind === 'symbol' ? { floorFrom: a.floorFrom, floorTo: a.floorTo } : null), planId: activeId }))
    // the Durchgänge that rode along with a moved Wand (lib/grundriss · carryDoors), as the last
    // rendered frame has them – the board funnel seats them after `written`, so it cannot say
    doorsOn(annos, barIds).forEach((d) => emit('board.edit', { id: d.id, patch: { x: d.x, y: d.y, floor: d.floor, rotation: d.rotation }, planId: activeId }))
  }
  const barMove = (dx: number, dy: number, phase: 'start' | 'move' | 'end') => {
    if (readOnly) return
    if (phase === 'start') { barSnapshot(); beginSheetPeek(); return }
    const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
    const t = { ndx: dx / rect.width, ndy: dy / rect.height, deg: 0 }
    const written = barApply(t, barCentre)
    if (phase === 'end') { endSheetPeek(); barCommit(written); onStepEnd?.() }
  }
  const barRotate = (deg: number, phase: 'start' | 'move' | 'end') => {
    if (readOnly) return
    // the turn is read on the sheet, beside its pivot (components/SelectionTurn)
    if (phase === 'end') setBarTurn(null)
    else if (phase === 'start') { const c = barCentreClient(); setBarTurn(c ? { cx: c.x, cy: c.y, deg: 0 } : null) }
    else setBarTurn((t) => (t ? { ...t, deg } : t))
    if (phase === 'start') { barRotCentre.current = barCentre; barSnapshot(); return }
    const written = barApply({ ndx: 0, ndy: 0, deg }, barRotCentre.current)
    if (phase === 'end') { barCommit(written); barRotCentre.current = null; onStepEnd?.() }
  }
  /** «Fertig» — the editing state ends: nothing selected, no mode armed, every sheet that was
   *  open for this selection closed. The bar carries no Löschen any more: an object is deleted
   *  from its own editor sheet and with the Delete key, which reaches natives and mirrors alike. */
  const barDone = () => {
    setSelId(null); setSelIds([]); setNotePanelId(null); setEditId(null); setAnnoTap(null)
  }
  /** ⟳ is absent, not inert, where the model carries no angle: an Absperrkreis is a centre and a
   *  radius — the native's and the mirror's alike. */
  const barCanRotate = selIds.length > 1 || editDraw?.kind !== 'circle'
  /** ✥ / ⟳ tapped instead of dragged: the same two writers, taken on the sheet itself. Capturing
   *  on `.wb-canvas` is also this surface's pan guard — the press never reaches `stageDown`, so
   *  no pan, no marquee and no placement can start under an armed drag (lib/useArmedTransform). */
  const [barTurn, setBarTurn] = useState<{ cx: number; cy: number; deg: number } | null>(null)
  const barCentreClient = () => {
    const r = boardRef.current?.getBoundingClientRect()
    return r && barCentre ? { x: r.left + barCentre.x * r.width, y: r.top + barCentre.y * r.height } : null
  }
  const arm = useArmedTransform({
    enabled: barActive,
    surface: () => canvasRef.current,
    centreClient: barCentreClient,
    onMove: barMove,
    onRotate: barCanRotate ? barRotate : undefined,
    // a different selection is a different thing to move, and an armed tool is a different
    // answer to the same press: neither carries the mode over
    resetKey: `${tool}|${barIds.join(',')}`,
  })

  return { barIds, barActive, barMove, barRotate, barDone, barCanRotate, barTurn, arm }
}
