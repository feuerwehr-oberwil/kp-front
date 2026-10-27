// The Plan's draft machine: the shape in the hand while Linie / Fläche / Absperrkreis is armed,
// the magnet of a line being drawn, the commit funnel (✓ «Fertig», a released freehand stroke,
// «Als Linie übernehmen») and the release that asks «Speichern · Verwerfen · Weiterzeichnen» when
// an open drawing is left. Lifted out of the Whiteboard (sweep A.1, 25.10.2026). The decisions are
// lib/draftMachine's and the magnet is lib/useDraftMagnet, the same two the Karte runs through
// lib/useMapDrawing (docs/tactical-objects.md · Lage ↔ Plan parity). The pointer plumbing that
// feeds it is the Whiteboard's ink overlay (components/usePlanCreate).
//
// On the Gebäude stack it also runs the Grundriss preset (27.10.2026, docs/plans-and-buildings.md
// · Drawing a Grundriss): the Wand of the Linie is an ordinary ink with a `role` and its own look,
// drawn in Punkte mode, snapped by lib/planSnap, and the tool stays armed after each piece. A
// Wand's corner dragged afterwards snaps the same way (snapWallVertex, for useWbVertexEdit).

import { useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool, LineAttachment } from '../types'
import { appConfig } from '../config/appConfig'
import { newId } from '../lib/ids'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
import { askOpenDraft, draftActive as isDraftActive, finishKind, releaseDraft as releaseDraftOf } from '../lib/draftMachine'
import { joinTargets, useDraftMagnet } from '../lib/useDraftMagnet'
import type { MagneticTarget } from '../lib/lineAttachments'
import { stackRange } from '../lib/stackFloors'
import { backtracks, segsOf, snapPoint, snapWall, type Anchor, type Pt, type Seg, type SnapResult, type SnapTargets } from '../lib/planSnap'
import type { PlanEndpointDrag } from './useWbVertexEdit'
import type { PlanLogExtra } from './Whiteboard'

const COLORS = appConfig.drawing.colors

/** The style every new Plan ink is born with – never the last edited ink's (3am sweep §2,
 *  23.10.2026; the Karte's twin is useMapDrawing · DRAW_DEFAULTS). */
export const INK_DEFAULTS = { color: appConfig.drawing.defaultColor, width: 5, dashed: false, marker: '', arrow: false } as const

/** The Grundriss preset of the Linie (the Wand) – `BoardAnno.role`. */
export type GrundrissRole = NonNullable<BoardAnno['role']>

/** The look a Wand is born with (1B mock, 27.10.2026): dark and solid, the building outline's
 *  weight and a touch bolder – 2 px against the outline's 1.5 (owner, round 2: «widths still
 *  off» at 3). Both are board px, which the board's size turns into screen px at every zoom
 *  (WbControls · the ink layer, 09-whiteboard.css · .wb-floor-svg polygon), so the two stay in
 *  proportion. Below the palette's smallest width (appConfig.drawing.widths), which no line
 *  editor offers since the «Stärke» row went (sweep 27.10.2026 #7). `COLORS[4]` is the palette's
 *  dark – on the board it is drawn in the theme's ink instead (WbControls · inkOf), so a wall
 *  stays visible on the night sheet; print and export keep the stored dark. */
export const GRUNDRISS_STYLE = {
  wand: { color: COLORS[4], width: 2 },
} as const satisfies Record<GrundrissRole, Partial<BoardAnno>>

/** The symbols a Leitung is laid through: its Punkte snap onto their centre (lib/planSnap). */
const PASSAGE_SYMBOLS: ReadonlySet<string> = new Set(['GB Ture Durchgang', 'GB Ture BS R30', 'GB Treppe 8'])

/** The snap ring under the pointer, in board px: where the next point would land, and the open
 *  draft's last point when it is on that storey (the mouse's rubber band runs from there). */
export interface SnapRing { x: number; y: number; snapped: boolean; from?: [number, number] }

interface Args {
  tool: BoardTool
  setTool: (tool: BoardTool) => void
  /** the sheet's drawn annos */
  annos: BoardAnno[]
  /** the board document's funnel (useBoardDoc) */
  add: (a: BoardAnno) => void
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  setSelId: (id: string | null) => void
  onLineAttached?: (annoId: string, attachment: LineAttachment) => void
  /** the magnet's surface: board px of a stored point, the sheet's target walk (`draftStart` is
   *  the claim the draft's first end already made), and what a target becomes */
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  /** board-normalized y → a storey's tile-local y (lib/whiteboard · floorGeometry) */
  localY: (ny: number, floor: number) => number
  /** the Gebäude floor stack: the Grundriss presets and the snap live here only */
  stack: boolean
  /** the building outline of a storey as rings in board px (none off the stack, or for a pack) */
  outlinePx?: (floor: number) => Pt[][]
  planCandidatesAt: (sourceId: string, pointer: [number, number], draftStart?: LineAttachment) => MagneticTarget[]
  planAttachmentFor: (c: MagneticTarget) => LineAttachment
  /** an endpoint drag in progress — its armed line target is rung «Angekuppelt» too */
  planEndpointDragState: PlanEndpointDrag | null
  /** the tool the live draft was laid under — the Whiteboard's, which releases the draft when the
   *  tool, the mode or the document changes; «Weiterzeichnen» re-arms it here */
  prevToolRef: React.MutableRefObject<BoardTool>
  /** «Weiterzeichnen» was picked: close whatever the leave opened (the symbol palette) */
  onContinue?: () => void
}

/** The Plan's draft machine; see the file header. WHEN the hand is released (a tool change,
 *  arming the Georeferenz, leaving the document) is the Whiteboard's to decide; it calls
 *  `releaseDraft`. Called where the create tools begin, so its effect runs where it always did. */
export function usePlanDraft({
  tool, setTool, annos, add, log, setSelId, onLineAttached,
  sW, sH, mapY, localY, stack, outlinePx, planCandidatesAt, planAttachmentFor, planEndpointDragState, prevToolRef, onContinue,
}: Args) {
  // Every new ink starts from the ONE plain default (INK_DEFAULTS) – the Karte's rule
  // (useMapDrawing · DRAW_DEFAULTS). Until 23.10.2026 the DrawEditor's edits were written back
  // here as the next ink's template, marker and arrowhead included (3am sweep §2).
  const { color, width, dashed, marker, arrow: lineArrow } = INK_DEFAULTS
  // Fläche: tapped nodes, or a dragged outline — the Lage map's `areaMode`, same default and
  // same reason (a fire's edge has no corners to tap).
  const [areaMode, setAreaMode] = useState<'nodes' | 'freehand'>('nodes')
  const [draft, setDraft] = useState<BoardPoint[] | null>(null)
  /** Absperrkreis being dragged out: centre (plan-normalized, storey-local) + radius as a
   *  fraction of the plan width. The drag IS the shape here, exactly as on the Karte
   *  (useMapCanvasGestures · circle), so it lives beside `draft` and never in the document. */
  const [circleDraft, setCircleDraft] = useState<{ x: number; y: number; floor: number; r: number } | null>(null)
  const draftAttachments = useRef<{ startAttachment?: LineAttachment; endAttachment?: LineAttachment }>({})
  // the single Linie tool's input mode: Freihand (drag) ↔ Punkte (tap each vertex), like the Lage map
  const [lineMode, setLineMode] = useState<'freehand' | 'nodes'>('freehand')
  // the storey the draft was started on (a Fläche pins every vertex to it)
  const draftFloor = useRef(0)
  // the Grundriss preset the Linie draws with (Gebäude stack; see `grundriss` below) …
  const [preset, setPreset] = useState<GrundrissRole | null>(null)
  // … and the one the draft in the hand was STARTED with: a release reads it after the tool (and
  // with it `grundriss`) has already moved on
  const [draftRole, setDraftRole] = useState<GrundrissRole | null>(null)
  // the snap ring under the pointer (SnapRing), drawn by the Whiteboard
  const [ring, setRing] = useState<SnapRing | null>(null)
  // A preset belongs to its armed tool: putting the Linie down puts it down too, so the next
  // Linie is a plain one again («Weiterzeichnen» re-arms both at once, see releaseDraft); the
  // ring goes with any tool change. Adjusted while rendering (the tool it was armed for is kept
  // beside it), so no effect re-renders the board a second time.
  const [armedFor, setArmedFor] = useState(tool)
  if (armedFor !== tool) {
    setArmedFor(tool)
    setRing(null)
    if (tool !== 'line') setPreset(null)
  }
  // the magnet of a line being DRAWN — the Karte's own machine (lib/useDraftMagnet), in board px
  // over the sheet's target walk (Whiteboard · planCandidatesAt / planAttachmentFor)
  const planMagnet = useDraftMagnet<BoardPoint>({
    project: (p) => [p[0] * sW, mapY(p[2], p[1]) * sH],
    candidates: (p) => planCandidatesAt('__draft__', [p[0] * sW, mapY(p[2], p[1]) * sH], draftAttachments.current.startAttachment),
    attachmentFor: (c) => planAttachmentFor(c),
  })
  const planDraftMagnetState = planMagnet.state
  // node-based (tap each vertex, then finish): the area tool, and the Linie tool in Punkte mode.
  // In Freihand mode the Linie tool drags a stroke instead (the Whiteboard's ink overlay).
  const noding = (tool === 'area' && areaMode === 'nodes') || (tool === 'line' && lineMode === 'nodes')
  /** the drag IS the shape right now — a freehand Linie or a freehand Fläche. The one
   *  predicate the three pointer handlers share, so the two tools cannot drift apart. */
  const inking = (tool === 'line' && lineMode === 'freehand') || (tool === 'area' && areaMode === 'freehand')
  // the in-progress node draft is committable: an area needs ≥3 pts, a Punkte-mode line ≥2 (gates ✓)
  const draftActive = isDraftActive(tool, { lineMode, areaMode }, draft?.length ?? 0)
  /** The draft magnet's phases from the ink overlay (lib/useDraftMagnet). `atStart` is the caller's
   *  claim on pointerDOWN only — a MOVE re-derives it from the stroke's own first point. What the
   *  press lands on is banked into `draftAttachments` at once, as the Trupp rule reads it
   *  (Whiteboard · planCandidatesAt). */
  const updatePlanDraftMagnet = (point: BoardPoint, phase: 'start' | 'move', atStart = false) => {
    if (phase === 'start') draftAttachments.current = { ...draftAttachments.current, ...planMagnet.start(point, atStart) }
    else planMagnet.move(point)
  }
  /** The «Angekuppelt» rings, the Karte's `joinPreview` in board px (lib/useDraftMagnet ·
   *  joinTargets), ringed in the TARGET line's ink. */
  const planJoinPreview = (): { key: string; point: [number, number]; color: string }[] =>
    joinTargets(planDraftMagnetState, planEndpointDragState)
      .map((c) => ({ key: c.key, point: c.point, color: annos.find((a) => a.id === c.target.id)?.color || COLORS[0] }))
  /** Settle the stroke's magnet: an end whose ring CLOSED fills its slot in `draftAttachments`,
   *  unless the press already banked one there. */
  const finishPlanDraftMagnet = () => {
    const out = planMagnet.end()
    if (!out) return
    const da = draftAttachments.current
    draftAttachments.current = {
      ...da,
      ...(!da.startAttachment && out.startAttachment ? { startAttachment: out.startAttachment } : {}),
      ...(!da.endAttachment && out.endAttachment ? { endAttachment: out.endAttachment } : {}),
    }
  }

  // create a Linie from a finished path (a freehand drag OR a node-tapped draft), baking the sticky
  // preset's arrow/marker/dash — or the Wand's look and `role`. Mirrors the Lage map's
  // createLine, so both surfaces behave identically. Returns the anno; addLine below is the
  // interactive wrapper (select + drop to pan so the style editor opens).
  // the board writer of the LATEST render: a «Speichern» answered later (releaseDraft, tapPoint)
  // must not write through the `add` of the render that asked – that one closes over the board as
  // it was then and would overwrite whatever landed while the question was open (a remote merge)
  const addRef = useRef(add)
  useLayoutEffect(() => { addRef.current = add })
  const commitLine = (pts: BoardPoint[], role?: GrundrissRole | null): BoardAnno => {
    const id = newId('l')
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = role
      ? { id, kind: 'draw', pts, floor, role, ...GRUNDRISS_STYLE[role] }
      : { id, kind: 'draw', pts, floor, color, width, ...draftAttachments.current,
          dashed: dashed || undefined, ...(marker ? { marker } : {}), ...(lineArrow ? { arrow: true } : {}) }
    addRef.current(anno)
    // a stroke that ENDED on a Trupp's chip is that Trupp's Leitung — both ends are reported,
    // because either of them may be the coupling (see Whiteboard · Props.onLineAttached)
    for (const a of [anno.startAttachment, anno.endAttachment]) if (a) onLineAttached?.(id, a)
    // the jump-back aims at the line's FIRST node: a Leitung can run across two floors, and the
    // end it was started from is the end the operator was standing at when the row was written
    const W = appConfig.copy.whiteboard
    log('pen', role === 'wand' ? W.placeWand : W.placeLine, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
    draftAttachments.current = {}
    return anno
  }
  const addLine = (pts: BoardPoint[]) => { const { id } = commitLine(pts); setSelId(id); setTool('pan') }
  // create a Fläche from a finished ring — the twin of commitLine/addLine: addArea selects it +
  // drops to pan so its draggable vertex handles are immediately usable (matches the Lage map,
  // where a finished area auto-selects for reshaping).
  // ⚠️ an area lives on ONE storey: the caller pins every vertex to the same floor.
  const commitArea = (pts: BoardPoint[]): BoardAnno => {
    const id = newId('a')
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'area', pts, floor, color, width, dashed }
    addRef.current(anno)
    log('area', appConfig.copy.whiteboard.placeArea, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
    return anno
  }
  const addArea = (pts: BoardPoint[]) => { const { id } = commitArea(pts); setSelId(id); setTool('pan') }
  // Absperrkreis / Gefahrenradius — the plan twin of the Karte's createCircle (lib/useMapDrawing):
  // the same hazard colour, dashed slim ring and default fill, undoable + journaled + audited
  // through the same `add`. Drops to pan with the circle selected so its radius stepper is right
  // there, exactly as the map's does.
  const addCircle = (x: number, y: number, floor: number, radiusN: number) => {
    const id = newId('c')
    add({ id, kind: 'circle', x, y, floor, radiusN, color: appConfig.drawing.circleColor,
      dashed: true, width: appConfig.drawing.circleLineWidth, fillOpacity: appConfig.drawing.circleFillOpacity })
    log('circle', appConfig.copy.whiteboard.placeCircle, { annoId: id, x, y, floor })
    setSelId(id); setTool('pan')
  }
  /** One piece of a Wand, committed while the tool stays ARMED (no selection, no pan) — each its
   *  own ↶. Null when the points are not a line yet. */
  const commitPiece = (pts: BoardPoint[], role: GrundrissRole): BoardAnno | null =>
    pts.length < 2 ? null : commitLine(pts, role)
  // commit the in-progress node shape: a Linie (≥2 pts) or a Fläche (≥3 pts, closed + filled) —
  // the Karte's rule (lib/draftMachine · finishKind). Then drop to pan so it's immediately
  // selectable — except a Grundriss piece, whose tool stays armed for the next one.
  const finishShape = () => {
    const d = draft
    const role = draftRole
    const kind = d ? finishKind(tool, d.length) : null
    if (role) {
      if (d && kind) { setDraft(null); commitPiece(d, role) }
      return
    }
    setDraft(null)
    if (d && kind === 'line') addLine(d)
    else if (d && kind === 'area') addArea(d)
    else setTool('pan')
  }
  const cancelShape = () => { setDraft(null); draftAttachments.current = {} }

  // --- the Grundriss preset and the snap (Gebäude stack only) ------------------------------
  /** the preset in force: the Wand on the Linie, on the stack only */
  const grundriss: GrundrissRole | null = stack && tool === 'line' ? preset : null
  /** board px of a stored point on its storey */
  const toPx = (p: BoardPoint): Pt => [p[0] * sW, mapY(p[2] ?? draftFloor.current, p[1]) * sH]
  /** What can pull a point on `floor` (lib/planSnap): the Wände and every Fläche (round 2: «snap
   *  to an area»), the draft's own points, the building outline, and the Durchgang / Treppe
   *  centres. `skip` leaves out one Wand corner being dragged and the two pieces at it. */
  const snapTargets = (floor: number, own: readonly BoardPoint[], skip?: { id: string; idx: number }): SnapTargets => {
    const segs: Seg[] = [], ends: Pt[] = [], centres: Pt[] = []
    const take = (pts: Pt[], closed: boolean) => { segs.push(...segsOf(pts, closed)); ends.push(...pts) }
    for (const a of annos) {
      if (((a.role === 'wand' && a.kind === 'draw') || a.kind === 'area') && a.pts && (a.floor ?? 0) === floor) {
        const px = a.pts.map(([x, y, f]): Pt | null => ((f ?? a.floor ?? 0) === floor ? [x * sW, mapY(floor, y) * sH] : null))
        if (skip?.id === a.id) {
          px.forEach((p, i) => { if (p && i !== skip.idx) ends.push(p) })
          segsOf(px.map((p) => p ?? [NaN, NaN])).forEach((sg, i) => { if (i !== skip.idx && i !== skip.idx - 1 && !sg.some((p) => Number.isNaN(p[0]))) segs.push(sg) })
        } else take(px.filter((p) => p != null), a.kind === 'area')
      } else if (a.kind === 'symbol' && a.symbol && PASSAGE_SYMBOLS.has(a.symbol) && a.x != null && a.y != null) {
        const { from, to } = stackRange(a)
        if (floor >= from && floor <= to) centres.push([a.x * sW, mapY(floor, a.y) * sH])
      }
    }
    take(own.map(toPx), false)
    for (const ring of outlinePx?.(floor) ?? []) take(ring, true)
    return { segs, ends, centres }
  }
  /** Where a Punkte tap at board-normalized `n` lands on `floor`, given the draft in the hand
   *  (`own`, this storey's points) and the drawing it belongs to. Off the stack, or for a
   *  Fläche, nothing pulls it. */
  const snapAt = (n: [number, number], floor: number, own: readonly BoardPoint[], role: GrundrissRole | null): SnapResult & { pt: BoardPoint } => {
    const free: BoardPoint = [n[0], localY(n[1], floor), floor]
    const at: Pt = [n[0] * sW, mapY(floor, free[1]) * sH]
    const mode = role ?? (tool === 'line' ? 'line' : null)
    if (!stack || !mode || !(sW > 0 && sH > 0)) return { p: [at[0], at[1]], snapped: false, pt: free }
    const res = snapPoint(at, { mode, draft: own.map(toPx), targets: snapTargets(floor, role ? own : []) })
    // a point nothing moved keeps the tap's own coordinates (no round trip through px)
    const moved = res.p[0] !== at[0] || res.p[1] !== at[1]
    return { ...res, pt: moved ? [res.p[0] / sW, localY(res.p[1] / sH, floor), floor] : free }
  }
  /** the snap ring for a pointer at board-normalized `n` (null clears it) — the mouse's hover and
   *  a finger's press; only where something can snap */
  const showRing = (n: [number, number] | null, floor: number, mouse: boolean) => {
    if (!n || !stack || !(grundriss || (tool === 'line' && lineMode === 'nodes'))) { setRing(null); return }
    const role = draft ? draftRole : grundriss
    // over another storey than the open piece's, a tap starts a new piece there (tapPoint)
    const own = draft && role && floor !== draftFloor.current ? [] : (draft ?? []).filter((p) => (p[2] ?? draftFloor.current) === floor)
    const s = snapAt(n, floor, own, role)
    const last = own[own.length - 1]
    const prev = own[own.length - 2]
    const back = role && last && prev && backtracks(toPx(prev), toPx(last), s.p)
    const next: SnapRing = { x: s.p[0], y: s.p[1], snapped: s.snapped, ...(mouse && last && !s.finish && !back ? { from: [...toPx(last)] as [number, number] } : {}) }
    // a pointer that stays caught on the same spot re-renders nothing
    setRing((was) => (was && was.x === next.x && was.y === next.y && was.snapped === next.snapped
      && was.from?.[0] === next.from?.[0] && was.from?.[1] === next.from?.[1] ? was : next))
  }

  /**
   * One Punkte tap on the ink overlay at board-normalized `n`, over storey `floor` — what
   * usePlanCreate hands every node tap of the Linie / Fläche. Plain inks: a Linie's points follow
   * the pointer's storey, a Fläche stays on its first; on the stack a Linie's point snaps onto a
   * Durchgang / Treppe. A Wand stays on its storey, snaps (lib/planSnap), finishes on its last
   * point, closes on its first, and a point straight back along the piece just drawn commits that
   * piece and starts the next one there (one ↶ per piece). A tap on ANOTHER storey while a piece
   * is open asks first, then starts there.
   */
  const tapPoint = (n: [number, number], floor: number) => {
    const role = draft ? draftRole : grundriss
    if (draft && role && floor !== draftFloor.current) {
      const d = draft
      const first = snapAt(n, floor, [], role).pt
      const startThere = () => { draftAttachments.current = {}; draftFloor.current = floor; setDraftRole(role); setDraft([first]) }
      // a lone first point is no piece: nothing to ask about
      if (d.length < 2) { startThere(); return }
      void askOpenDraft(drawingName('line', role)).then((answer) => {
        if (answer === 'continue') return
        if (answer === 'save') commitPiece(d, role)
        startThere()
      })
      return
    }
    if (!draft) { draftFloor.current = floor; setDraftRole(role) }
    const pointFloor = tool === 'line' && !role ? floor : draftFloor.current
    const own = (draft ?? []).filter((p) => (p[2] ?? draftFloor.current) === pointFloor)
    const s = snapAt(n, pointFloor, own, role)
    if (role && draft) {
      if (s.finish) { finishShape(); return }
      if (s.close) { closePiece(); return }
      const last = draft[draft.length - 1], prev = draft[draft.length - 2]
      if (prev && backtracks(toPx(prev), toPx(last), s.p)) {
        commitPiece(draft, role)
        setDraft([s.pt])
        return
      }
    }
    setDraft((d) => (d ? [...d, s.pt] : [s.pt]))
  }
  /** Close the open Wand on its first point: it runs back to where it started. The tool stays
   *  armed. */
  const closePiece = () => {
    const d = draft, role = draftRole
    if (!d || !role) return
    setDraft(null)
    commitPiece([...d, d[0]], role)
  }
  /** A still tap on one of the draft's own grips (WbDraftHandles sit above the ink overlay, so a
   *  tap there never reaches tapPoint): on a Wand the last point finishes it and the first of a
   *  Wand with ≥3 points closes it. A plain ink's grips only reshape. */
  const tapDraftVertex = (idx: number) => {
    const d = draft, role = draftRole
    if (!d || !role) return
    if (idx === d.length - 1) finishShape()
    else if (idx === 0 && d.length >= 3) closePiece()
  }
  /** Pick the Linie's / Fläche's input on the dock: Freihand, Punkte, or (Linie, on the stack) the
   *  Wand. An open drawing of another kind is left first (it asks), so a Wand never turns into a
   *  Leitung half-way. */
  const pickInput = (next: 'freehand' | 'nodes' | GrundrissRole) => {
    const role = next === 'freehand' || next === 'nodes' || tool !== 'line' ? null : next
    const mode = next === 'freehand' ? 'freehand' : 'nodes'
    if (draft?.length && (role !== draftRole || mode === 'freehand')) releaseDraft(tool)
    setPreset(role)
    if (tool === 'area') setAreaMode(mode)
    else setLineMode(mode)
  }

  /**
   * Where a Wand's corner dragged to board-normalized `n` lands (useWbVertexEdit · vertMove): the
   * same targets and the same right-angle preference as drawing, against BOTH of its neighbours,
   * minus the corner itself and its two pieces. Shows the ring there; `null` for `n` clears it.
   * Returns the stored point, on the Wand's own storey.
   */
  const snapWallVertex = (wall: BoardAnno, idx: number, n: [number, number] | null): BoardPoint | null => {
    if (!n || !wall.pts) { setRing(null); return null }
    const floor = wall.pts[idx]?.[2] ?? wall.floor ?? 0
    const free: BoardPoint = [n[0], localY(n[1], floor), floor]
    if (!stack || !(sW > 0 && sH > 0)) return free
    const px = (p?: BoardPoint): Pt | undefined => (p && (p[2] ?? wall.floor ?? 0) === floor ? [p[0] * sW, mapY(floor, p[1]) * sH] : undefined)
    const anchors: Anchor[] = []
    for (const [nb, before] of [[idx - 1, idx - 2], [idx + 1, idx + 2]]) {
      const from = px(wall.pts[nb])
      if (from) anchors.push({ from, before: px(wall.pts[before]) })
    }
    const s = snapWall([n[0] * sW, mapY(floor, free[1]) * sH], { anchors, targets: snapTargets(floor, [], { id: wall.id, idx }) })
    setRing({ x: s.p[0], y: s.p[1], snapped: s.snapped })
    return [s.p[0] / sW, localY(s.p[1] / sH, floor), floor]
  }

  // --- leaving an open drawing (27.10.2026: asks; replaced the A6 auto-commit of 29.08.) ------
  /** what the open drawing is called in the question and on its pill */
  const drawingName = (kind: 'line' | 'area', role: GrundrissRole | null) =>
    role ? appConfig.copy.whiteboard.grundriss[role] : kind === 'line' ? appConfig.copy.drawingEditor.line : appConfig.copy.drawingEditor.area
  /**
   * Whatever disarms a create tool with a draft still in the hand — picking another tool or mode,
   * ✕, Escape, arming the Georeferenz, switching the document, leaving the surface — lands here
   * (the Lage map runs the identical contract — the decision and the question are
   * lib/draftMachine's). A committable draft (Punkte-Linie ≥2, Fläche ≥3) asks «Speichern ·
   * Verwerfen · Weiterzeichnen»: the leave itself goes through at once and the drawing waits in
   * the question — «Speichern» commits it through the same commitLine/commitArea the ✓ takes (one
   * ↶, no selection stolen), «Weiterzeichnen» hands it back to the hand under its re-armed tool.
   * `ask: false` is the leave nobody can answer for — the DOCUMENT goes, and with it the funnel
   * the answer would write through: it commits at once and a toast says so. A fragment below the
   * minimum and a mid-stroke Freihand remnant go silently.
   */
  const releaseDraft = (from: BoardTool, { ask = true }: { ask?: boolean } = {}) => {
    const d = draft
    if (!d?.length) return
    const role = draftRole
    const release = releaseDraftOf({ from, lineMode: role ? 'nodes' : lineMode, count: d.length, ask })
    if (release.type === 'keep') return
    setDraft(null)
    const att = { ...draftAttachments.current } // commitLine consumes the ref
    draftAttachments.current = {}
    if (release.type === 'drop' || release.type === 'discard') return
    const kind = release.kind
    const save = () => {
      draftAttachments.current = att
      if (kind === 'line') commitLine(d, role)
      else commitArea(d)
    }
    const name = drawingName(kind, role)
    if (release.type === 'commit') {
      save()
      toast(fillTemplate(appConfig.copy.toolDock.autoCommitted, { name }))
      return
    }
    void askOpenDraft(name).then((answer) => {
      if (answer === 'save') save()
      else if (answer === 'continue') {
        draftAttachments.current = att
        draftFloor.current = d[0]?.[2] ?? 0
        setDraftRole(role)
        setDraft(d)
        if (kind === 'line') setLineMode('nodes')
        else setAreaMode('nodes')
        setPreset(role)
        // pre-set the release's memory so re-arming the tool is not itself a leave
        prevToolRef.current = kind
        setTool(kind)
        onContinue?.()
      }
    })
  }

  return {
    lineMode, setLineMode, areaMode, setAreaMode, draft, setDraft, circleDraft, setCircleDraft,
    // refs the ink overlay and the vertex grips write too — named as refs across the hook boundary
    draftAttachmentsRef: draftAttachments, draftFloorRef: draftFloor, setDraftRole,
    noding, inking, draftActive, planDraftMagnetState, updatePlanDraftMagnet, planJoinPreview, finishPlanDraftMagnet,
    addLine, addArea, addCircle, finishShape, cancelShape, releaseDraft,
    grundriss, pickInput, tapPoint, tapDraftVertex, snapWallVertex, ring, showRing, openName: draft?.length ? drawingName(tool === 'area' ? 'area' : 'line', draftRole) : null,
  }
}
