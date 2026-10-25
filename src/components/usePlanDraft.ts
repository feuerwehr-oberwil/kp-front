// The Plan's draft machine: the shape in the hand while Linie / Fläche / Absperrkreis is armed,
// the magnet of a line being drawn, the commit funnel (✓ «Fertig», a released freehand stroke,
// «Als Linie übernehmen») and the A6 tap-away release with its «Rückgängig». Lifted out of the
// Whiteboard (sweep A.1, 25.10.2026). The decisions are lib/draftMachine's and the magnet is
// lib/useDraftMagnet, the same two the Karte runs through lib/useMapDrawing (docs/tactical-objects.md
// · Lage ↔ Plan parity). The pointer plumbing that feeds it is the Whiteboard's ink overlay.

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool, LineAttachment } from '../types'
import { appConfig } from '../config/appConfig'
import { newId } from '../lib/ids'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
import { draftActive as isDraftActive, finishKind, releaseDraft as releaseDraftOf } from '../lib/draftMachine'
import { joinTargets, useDraftMagnet } from '../lib/useDraftMagnet'
import type { MagneticTarget } from '../lib/lineAttachments'
import { recordKey, watchRecords } from '../lib/undoKeys'
import { newPlanStep, pushBoardPast, type BoardHistory } from './useBoardDoc'
import type { PlanEndpointDrag } from './useWbVertexEdit'
import type { PlanLogExtra } from './Whiteboard'

const COLORS = appConfig.drawing.colors

/** The style every new Plan ink is born with – never the last edited ink's (3am sweep §2,
 *  23.10.2026; the Karte's twin is useMapDrawing · DRAW_DEFAULTS). */
export const INK_DEFAULTS = { color: appConfig.drawing.defaultColor, width: 5, dashed: false, marker: '', arrow: false } as const

interface Args {
  tool: BoardTool
  setTool: (tool: BoardTool) => void
  /** the sheet's drawn annos … */
  annos: BoardAnno[]
  /** … and the whole list with its riders, which the auto-commit's «Rückgängig» snapshots */
  annosAll: BoardAnno[]
  activeId: string
  /** the sheet's writer that puts the riders back (Whiteboard · onChange) */
  onChange: (next: BoardAnno[]) => void
  /** the board document's funnel (useBoardDoc) and the plan's half of the undo timeline */
  add: (a: BoardAnno) => void
  setHist: React.Dispatch<React.SetStateAction<BoardHistory>>
  onCheckpoint?: (planId: string, step: string) => void
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  setSelId: (id: string | null) => void
  onLineAttached?: (annoId: string, attachment: LineAttachment) => void
  /** the magnet's surface: board px of a stored point, the sheet's target walk (`draftStart` is
   *  the claim the draft's first end already made), and what a target becomes */
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  planCandidatesAt: (sourceId: string, pointer: [number, number], draftStart?: LineAttachment) => MagneticTarget[]
  planAttachmentFor: (c: MagneticTarget) => LineAttachment
  /** an endpoint drag in progress — its armed line target is rung «Angekuppelt» too */
  planEndpointDragState: PlanEndpointDrag | null
  /** the tool the live draft was laid under — the Whiteboard's, which releases the draft when the
   *  tool, the mode or the document changes; the auto-commit's «Rückgängig» re-arms it here */
  prevToolRef: React.MutableRefObject<BoardTool>
}

/** The Plan's draft machine; see the file header. WHEN the hand is released (a tool change,
 *  arming the Georeferenz, leaving the document) is the Whiteboard's to decide; it calls
 *  `releaseDraft`. Called where the create tools begin, so its effect runs where it always did. */
export function usePlanDraft({
  tool, setTool, annos, annosAll, activeId, onChange, add, setHist, onCheckpoint, log, emit, setSelId, onLineAttached,
  sW, sH, mapY, planCandidatesAt, planAttachmentFor, planEndpointDragState, prevToolRef,
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
  // preset's arrow/marker/dash. Mirrors the Lage map's createLine, so both surfaces behave
  // identically. Returns the anno so the tap-away auto-commit (releaseDraft) can offer its undo;
  // addLine below is the interactive wrapper (select + drop to pan so the style editor opens).
  const commitLine = (pts: BoardPoint[]): BoardAnno => {
    const id = newId('l')
    const floor = pts[0]?.[2] ?? draftFloor.current
    const anno: BoardAnno = { id, kind: 'draw', pts, floor, color, width, ...draftAttachments.current,
      dashed: dashed || undefined, ...(marker ? { marker } : {}), ...(lineArrow ? { arrow: true } : {}) }
    add(anno)
    // a stroke that ENDED on a Trupp's chip is that Trupp's Leitung — both ends are reported,
    // because either of them may be the coupling (see Whiteboard · Props.onLineAttached)
    for (const a of [anno.startAttachment, anno.endAttachment]) if (a) onLineAttached?.(id, a)
    // the jump-back aims at the line's FIRST node: a Leitung can run across two floors, and the
    // end it was started from is the end the operator was standing at when the row was written
    log('pen', appConfig.copy.whiteboard.placeLine, { annoId: id, x: pts[0]?.[0], y: pts[0]?.[1], floor })
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
    add(anno)
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
  // commit the in-progress node shape: a Linie (≥2 pts) or a Fläche (≥3 pts, closed + filled) —
  // the Karte's rule (lib/draftMachine · finishKind). Then drop to pan so it's immediately selectable.
  const finishShape = () => {
    const d = draft
    const kind = d ? finishKind(tool, d.length) : null
    setDraft(null)
    if (d && kind === 'line') addLine(d)
    else if (d && kind === 'area') addArea(d)
    else setTool('pan')
  }
  const cancelShape = () => { setDraft(null); draftAttachments.current = {} }

  // --- A6 (29.08.): tap-away must not silently discard a node draft -------------------------
  // live mirrors for the auto-commit toast's «Rückgängig», which fires seconds later from outside
  // any render: the same-sheet undo must act on the annos/document of NOW, not of commit time.
  // the WHOLE sheet (pages included): these refs feed a history snapshot, and onChange puts the pages back anyway
  const annosRef = useRef(annosAll); const activeIdRef = useRef(activeId); const onChangeRef = useRef(onChange)
  useEffect(() => { annosRef.current = annosAll; activeIdRef.current = activeId; onChangeRef.current = onChange })
  /**
   * Whatever disarms a create tool with a draft still in the hand — picking another tool, arming
   * the Georeferenz, switching the document, leaving the surface — lands here (A6, 29.08.; the
   * Lage map runs the identical contract — the decision is lib/draftMachine · releaseDraft). A
   * committable draft (Punkte-Linie ≥2, Fläche ≥3) auto-commits through the same
   * commitLine/commitArea path the ✓ takes, with a toast whose «Rückgängig» does more than delete:
   * it hands the SHAPE back as the draft and re-arms its tool — decided: undo returns the shape to
   * the hand. A fragment below the minimum has nothing worth keeping and says so in an action-less
   * toast; a mid-stroke Freihand remnant dies with its tool. Escape is deliberately NOT routed
   * through here — it is the one EXPLICIT discard (see the Whiteboard's Escape handler).
   */
  const releaseDraft = (from: BoardTool) => {
    const d = draft
    if (!d?.length) return
    const release = releaseDraftOf({ from, lineMode, count: d.length })
    if (release.type === 'keep') return
    setDraft(null)
    if (release.type !== 'commit') {
      draftAttachments.current = {}
      if (release.type === 'discard') toast(appConfig.copy.toolDock.draftDiscarded)
      return
    }
    const kind = release.kind
    const att = { ...draftAttachments.current } // commitLine consumes the ref — kept for the undo
    const planId = activeId
    const anno = kind === 'line' ? commitLine(d) : commitArea(d)
    // the take-back deletes this ONE anno — spent once another device's merge changed it
    // (lib/undoKeys · watchRecords), so it can never delete their edit
    const watch = watchRecords([recordKey('objects', anno.id)])
    toast(fillTemplate(appConfig.copy.toolDock.autoCommitted, { name: kind === 'line' ? appConfig.copy.drawingEditor.line : appConfig.copy.drawingEditor.area }), {
      onDismiss: watch.release,
      action: {
        label: appConfig.copy.toolDock.autoCommitUndo,
        onClick: () => {
          watch.release()
          if (!watch.ok()) { toast(appConfig.copy.undoLost, { icon: 'warn' }); return }
          if (activeIdRef.current === planId) {
            // still on this sheet: take the anno back and put the shape in the hand again
            const step = newPlanStep()
            setHist((m) => pushBoardPast(m, planId, annosRef.current, step)); onCheckpoint?.(planId, step)
            onChangeRef.current(annosRef.current.filter((a) => a.id !== anno.id))
            emit('board.delete', { id: anno.id, planId })
            draftAttachments.current = att
            draftFloor.current = d[0]?.[2] ?? 0
            setDraft(d)
            if (kind === 'line') setLineMode('nodes')
            // pre-set the release's memory so re-arming the tool is not itself a tap-away
            prevToolRef.current = kind === 'line' ? 'line' : 'area'
            setTool(kind === 'line' ? 'line' : 'area')
          } else {
            // the document was left mid-toast: the anno still comes off its own sheet (through
            // this closure, which still points there), but a draft cannot be handed back onto a
            // document that is no longer open
            const step = newPlanStep()
            setHist((m) => pushBoardPast(m, planId, [...annosAll, anno], step)); onCheckpoint?.(planId, step)
            onChange(annos)
            emit('board.delete', { id: anno.id, planId })
          }
        },
      },
    })
  }

  return {
    lineMode, setLineMode, areaMode, setAreaMode, draft, setDraft, circleDraft, setCircleDraft,
    // refs the ink overlay and the vertex grips write too — named as refs across the hook boundary
    draftAttachmentsRef: draftAttachments, draftFloorRef: draftFloor,
    noding, inking, draftActive, planDraftMagnetState, updatePlanDraftMagnet, planJoinPreview, finishPlanDraftMagnet,
    addLine, addArea, addCircle, finishShape, cancelShape, releaseDraft,
  }
}
