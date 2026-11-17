import { useEffect, useLayoutEffect, useState, useRef } from 'react'
import type React from 'react'
import { calibrate, pathMetres, polyAreaM2, isStale, type PlanScale } from '../lib/planScale'
import { resolvePlanScale } from '../lib/stationPlanScale'

import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
import { useNodeHold } from '../lib/nodeHold'
import { useFreshPoint } from '../lib/useFreshPoint'
import type { BoardTool } from '../types'
import type { PlanScales } from '../lib/workspace'
import type { PlanLogExtra } from './Whiteboard'

type Pt = [number, number]

interface Args {
  activeId: string
  /** floor-stack document: every storey tile is measured in its own space */
  stack: boolean
  /** h/w of the active sheet (single-sheet docs only) */
  aspect: number
  /** …and on a STACK the storey band's own h/w (lib/whiteboard · tileAspectOf): the measurement
   *  space is one tile, so this is the number a calibration is stored against */
  tileAR: number
  planScale: PlanScales
  /** whole-board normalized y → tile-local y, and which floor a y falls on */
  localY: (y: number, floor: number) => number
  floorAt: (y: number) => number
  tool: BoardTool
  setTool: (t: BoardTool) => void
  /** client point → normalized 0..1 in plan space */
  toNorm: (clientX: number, clientY: number) => Pt | null
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  onCalibrate?: (planId: string, scale: PlanScale | null) => void
  /** this surface may set a plan's scale (not a locked session) – then Messen on a plan without
   *  one starts at «Massstab» */
  canCalibrate: boolean
  /** A DERIVED metre factor — a finished map↔plan fit, or (on a georeferenced Gebäude, A7) the
   *  footprint's own ground size via lib/footprint · stackScaleMPerU. Never stored as a second
   *  calibration; sits below an incident-specific manual reference but above a station fallback. */
  autoScale?: PlanScale
}

/**
 * Plan-Maßstab (calibration) + Messen (ephemeral distance/area), the one domain on the
 * whiteboard that owns its own state end to end: nothing here is ever written to the board
 * document, and nothing outside reads it except the panel and the overlay that draw it.
 *
 * Both halves share one idea — the measurement space — which is why they are one hook and not
 * two: a calibration is only meaningful in the space its reference was drawn in, and a measured
 * path has to be converted into that same space before it can be turned into metres.
 *
 * (Messen left the Plan on 29.08. in favour of «draw a Linie, read its metres» — and came BACK
 * on 02.09.: in the field the quick throwaway question — «wie weit ist das?» — kept reaching
 * for a tool that was gone, and a drawn Linie is a journal-logged act, not a glance.)
 */
export function usePlanMeasure({ activeId, stack, aspect, tileAR, planScale, localY, floorAt, tool, setTool, toNorm, log, onCalibrate, canCalibrate, autoScale }: Args) {
  // Plan-Maßstab calibration: the reference is captured by tapping its TWO endpoints (nodes), then
  // a popover asks for its real length. The length THIS session last typed is pre-filled (plans
  // share similar bars) – never a stock 10 m: on a plan nobody has calibrated, a number already in
  // the field made the wrong answer one tap (C9, rare-user round 17.11.2026). `why`: the prompt was
  // reached from Messen, so it first says that the plan has no scale yet.
  const [calNodes, setCalNodes] = useState<Pt[]>([])
  const [calPrompt, setCalPrompt] = useState<{ a: Pt; b: Pt; why?: boolean } | null>(null)
  /** «Massstab» was lit by itself – Messen was opened on a plan without a scale – so the length
   *  dialog says why (`calPrompt.why`). A ref: only the second tap reads it, nothing draws it. */
  const calWhyRef = useRef(false)
  const [lastRefM, setLastRefM] = useState<number | null>(null)
  const [refMInput, setRefMInput] = useState<string>('')
  // after a fresh field calibration: offer to persist it station-wide (#3) — as the default for
  // every plan, or just for this one. Cleared on plan switch so it never lingers on another sheet.
  const [savePrompt, setSavePrompt] = useState<PlanScale | null>(null)
  useEffect(() => { setSavePrompt(null) }, [activeId])
  // Messen (measure): node-based distance / area, ephemeral (never saved). Each mode keeps its own
  // points, exactly like the Lage map's useMeasure. Metrics come from the plan calibration.
  const [measMode, setMeasMode] = useState<'line' | 'area'>('line')
  const [measLine, setMeasLine] = useState<Pt[]>([])
  const [measArea, setMeasArea] = useState<Pt[]>([])
  // drag a Messen vertex (ephemeral measurement path; mirrors vertDrag but never persisted)
  const measDrag = useRef<{ idx: number; moved: boolean } | null>(null)

  // Measurement is aspect-corrected: a normalized segment's true length depends on the plan's
  // aspect ratio (width / height). On a single sheet that's 1/aspect; on a floor-stack each storey
  // TILE is measured in its own space (1/tileAR), so one calibration covers every floor of the
  // same drawing. The reference drag and stored line `pts` live in this same space.
  const measureAR = stack ? 1 / tileAR : 1 / aspect
  // Resolve through the STATION calibration (per-incident → per-plan override → station default),
  // so a plan measures out of the box without re-calibrating each incident (#3). A field
  // calibration for this incident still wins; a stale candidate falls through.
  const workspaceScale: PlanScale | undefined = planScale[activeId]
  const validWorkspaceScale = workspaceScale && !isStale(workspaceScale, measureAR) ? workspaceScale : undefined
  /**
   * ⚠️ …with ONE surface where that order is inverted: the Gebäude floor-stack.
   *
   * A hand calibration is somebody drawing a reference line across a drawing and typing what they
   * believe it spans. The stack needs nobody to do that — it was traced off a footprint whose
   * ground size came with it from the Geoportal (`geo.spanM`), so its metres are measured, not
   * believed, and the derived number can only be the better of the two. Letting an old stored
   * calibration outrank it made the Gebäude read as hand-calibrated — offering «Neu kalibrieren»
   * on the one document that never needs it.
   *
   * The stored scale is kept, not dropped: a legacy building carries no `geo` (types · BuildingDoc),
   * `autoScale` is then undefined, and the manual path is still the only thing that can answer.
   */
  const activeScale: PlanScale | undefined = stack && autoScale
    ? autoScale
    : validWorkspaceScale ?? autoScale ?? resolvePlanScale(activeId, undefined, measureAR)
  const scaleAuto = !!autoScale && activeScale === autoScale
  const scaleStale = !!workspaceScale && isStale(workspaceScale, measureAR) && !activeScale
  const calibrated = !!activeScale
  // metres of a stored polyline (tile-local pts already, for a floor-stack) under the calibration
  const planMetres = (pts: Pt[]): number | null =>
    calibrated && activeScale ? pathMetres(pts, activeScale.mPerU, measureAR) : null
  // convert a board-normalized point into the measurement space (tile-local y on a floor-stack)
  const toMeasurePt = (n: Pt): Pt => stack ? [n[0], localY(n[1], floorAt(n[1]))] : n

  // --- Messen: the active path + calibrated metrics for the panel (line OR area, per mode) ---
  const measPath = measMode === 'line' ? measLine : measArea
  // the point a tap just placed lets the tap pair's second press through to the zoom (lib/useFreshPoint)
  const measFresh = useFreshPoint(measPath.length)
  const setMeasPath = (fn: (pts: Pt[]) => Pt[]) => (measMode === 'line' ? setMeasLine(fn) : setMeasArea(fn))
  const measMpts = measPath.map(toMeasurePt)
  const measLenM = calibrated && activeScale ? pathMetres(measMpts, activeScale.mPerU, measureAR) : 0
  const measAreaM2 = calibrated && activeScale ? polyAreaM2(measMpts, activeScale.mPerU, measureAR) : 0
  const measPerimM = calibrated && activeScale && measMpts.length >= 3 ? pathMetres([...measMpts, measMpts[0]], activeScale.mPerU, measureAR) : 0
  const measReset = () => { setMeasLine([]); setMeasArea([]) }
  /** everything this hook owns that must not survive a document switch */
  const resetEphemeral = () => { setMeasLine([]); setMeasArea([]); setCalNodes([]); setCalPrompt(null) }

  // a half-laid Messen path / Maßstab tap is ephemeral, so clear them when leaving those tools.
  // …and Messen on a plan that has no scale yet IS calibrating: «Massstab» lit by itself, whatever
  // opened Messen (the rail, a key, «Rückgängig» on the calibration, a switch to another sheet) –
  // taps on «Strecke» there used to calibrate silently (rare-user r4, owner: «automatically
  // selected if "Messen" doesn't have a Massstab yet»). A layout effect, so «Strecke» never paints.
  // (Layout effects, both: they run in this order, so the second one's `calWhyRef` stands.)
  useLayoutEffect(() => {
    if (tool !== 'measure') { setMeasLine([]); setMeasArea([]) }
    if (tool !== 'scale') { setCalNodes([]); calWhyRef.current = false }
  }, [tool])
  useLayoutEffect(() => {
    if (tool === 'measure' && !calibrated && canCalibrate) { calWhyRef.current = true; setTool('scale') }
  }, [tool, calibrated, canCalibrate, setTool])

  // --- Messen node editing (ephemeral; mirrors the vertex handlers but on the measure path) ---
  const measNodeDown = (idx: number, e: React.PointerEvent) => {
    if (tool !== 'measure') return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    measDrag.current = { idx, moved: false }
  }
  const measMove = (e: React.PointerEvent) => {
    const st = measDrag.current; if (!st) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    st.moved = true
    setMeasPath((p) => p.map((q, i) => (i === st.idx ? n : q)))
  }
  const measUp = () => { measDrag.current = null }
  /** is a measure vertex mid-drag? The board's shared pointermove asks before routing to measMove. */
  const measDragging = () => measDrag.current !== null
  /** Insert a node at the midpoint of segment `idx` — and keep the SAME press, now dragging the
   *  node it just made (the twin of Whiteboard · insertVertex). Releasing without moving leaves it
   *  at the midpoint, which is all a tap on the «+» ever did. */
  const measInsert = (idx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    setMeasPath((p) => { const b = p[(idx + 1) % p.length]; const mid: Pt = [(p[idx][0] + b[0]) / 2, (p[idx][1] + b[1]) / 2]; return [...p.slice(0, idx + 1), mid, ...p.slice(idx + 1)] })
    measDrag.current = { idx: idx + 1, moved: true }
  }
  const measDelete = (idx: number) => { measDrag.current = null; setMeasPath((p) => p.filter((_, i) => i !== idx)) }
  // touch path for node delete — double-tap rarely synthesizes dblclick on iOS
  const measPress = useNodeHold()

  // leaving the metre-entry popover goes back to step 1, «Massstab» still lit: it is how a wrong
  // point is taken back (the dock has no «Leeren» in this mode); the dock's «Abbrechen» stops
  const closeCalPrompt = () => setCalPrompt(null)
  // commit the metre-entry popover: derive + persist the calibration factor for this plan, then
  // the dock goes on to «Strecke» – the scale is set to measure something (rare-user r4)
  const commitCalibration = (refM: number) => {
    if (!calPrompt) return
    const a = toMeasurePt(calPrompt.a), b = toMeasurePt(calPrompt.b)
    const sc = calibrate(a, b, refM, measureAR)
    setCalPrompt(null)
    if (!sc || !onCalibrate) return
    setLastRefM(refM)
    // what this incident had before – the hand calibration it replaces, or none
    const before = planScale[activeId] ?? null
    onCalibrate(activeId, sc)
    setMeasMode('line')
    setTool('measure')
    const C = appConfig.copy.whiteboard.scale
    const said = fillTemplate(C.saved, { m: String(refM) })
    log('measure', said)
    setSavePrompt(sc) // editor: offer to remember it across incidents
    // the one toast of the rare-user round (C9): a wrong length makes every metre on this plan
    // wrong, so the calibration can be taken back right here – the plan's own value restored, the
    // «merken?» bar gone with it (nothing has been remembered yet unless it was answered)
    toast(said, {
      icon: 'measure', kind: 'plan-scale',
      action: { label: appConfig.copy.undo, onClick: () => { onCalibrate(activeId, before); setSavePrompt(null); log('measure', C.undone) } },
    })
  }

  return {
    calNodes, setCalNodes, calPrompt, setCalPrompt, calWhyRef, lastRefM, refMInput, setRefMInput, savePrompt, setSavePrompt,
    measMode, setMeasMode, measLine, setMeasLine, measArea, setMeasArea,
    measureAR, activeScale, scaleAuto, scaleStale, calibrated, planMetres, toMeasurePt,
    measPath, setMeasPath, measFresh, measMpts, measLenM, measAreaM2, measPerimM, measReset, resetEphemeral,
    measNodeDown, measMove, measUp, measDragging, measInsert, measDelete, measPress,
    closeCalPrompt, commitCalibration,
  }
}
