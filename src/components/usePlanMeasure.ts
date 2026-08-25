import { useEffect, useState, useRef } from 'react'
import type React from 'react'
import { calibrate, pathMetres, polyAreaM2, isStale, type PlanScale } from '../lib/planScale'
import { resolvePlanScale } from '../lib/stationPlanScale'
import { TILE_AR } from '../lib/whiteboard'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
import { useNodeHold } from '../lib/nodeHold'
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
}

/**
 * Plan-Maßstab (calibration) + Messen (ephemeral distance/area), the one domain on the
 * whiteboard that owns its own state end to end: nothing here is ever written to the board
 * document, and nothing outside reads it except the panel and the overlay that draw it.
 *
 * Both halves share one idea — the measurement space — which is why they are one hook and not
 * two: a calibration is only meaningful in the space its reference was drawn in, and a measured
 * path has to be converted into that same space before it can be turned into metres.
 */
export function usePlanMeasure({ activeId, stack, aspect, planScale, localY, floorAt, tool, setTool, toNorm, log, onCalibrate }: Args) {
  // Plan-Maßstab calibration: the reference is captured by tapping its TWO endpoints (nodes), then
  // a popover asks for its real length. last-used length is pre-filled (plans share similar bars).
  const [calNodes, setCalNodes] = useState<Pt[]>([])
  const [calPrompt, setCalPrompt] = useState<{ a: Pt; b: Pt } | null>(null)
  const [lastRefM, setLastRefM] = useState<number>(appConfig.drawing.planScaleDefaultM)
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
  // TILE is measured in its own space (1/TILE_AR), so one calibration covers every floor of the
  // same drawing. The reference drag and stored line `pts` live in this same space.
  const measureAR = stack ? 1 / TILE_AR : 1 / aspect
  // Resolve through the STATION calibration (per-incident → per-plan override → station default),
  // so a plan measures out of the box without re-calibrating each incident (#3). A field
  // calibration for this incident still wins; a stale candidate falls through.
  const workspaceScale: PlanScale | undefined = planScale[activeId]
  const activeScale: PlanScale | undefined = resolvePlanScale(activeId, workspaceScale, measureAR)
  const scaleStale = !!workspaceScale && isStale(workspaceScale, measureAR) && !activeScale
  const calibrated = !!activeScale
  // metres of a stored polyline (tile-local pts already, for a floor-stack) under the calibration
  const planMetres = (pts: Pt[]): number | null =>
    calibrated && activeScale ? pathMetres(pts, activeScale.mPerU, measureAR) : null
  // convert a board-normalized point into the measurement space (tile-local y on a floor-stack)
  const toMeasurePt = (n: Pt): Pt => stack ? [n[0], localY(n[1], floorAt(n[1]))] : n

  // --- Messen: the active path + calibrated metrics for the panel (line OR area, per mode) ---
  const measPath = measMode === 'line' ? measLine : measArea
  const setMeasPath = (fn: (pts: Pt[]) => Pt[]) => (measMode === 'line' ? setMeasLine(fn) : setMeasArea(fn))
  const measMpts = measPath.map(toMeasurePt)
  const measLenM = calibrated && activeScale ? pathMetres(measMpts, activeScale.mPerU, measureAR) : 0
  const measAreaM2 = calibrated && activeScale ? polyAreaM2(measMpts, activeScale.mPerU, measureAR) : 0
  const measPerimM = calibrated && activeScale && measMpts.length >= 3 ? pathMetres([...measMpts, measMpts[0]], activeScale.mPerU, measureAR) : 0
  const measReset = () => { setMeasLine([]); setMeasArea([]) }
  /** everything this hook owns that must not survive a document switch */
  const resetEphemeral = () => { setMeasLine([]); setMeasArea([]); setCalNodes([]); setCalPrompt(null) }

  // a half-laid Messen path / Maßstab tap is ephemeral, so clear them when leaving those tools
  useEffect(() => {
    if (tool !== 'measure') { setMeasLine([]); setMeasArea([]) }
    if (tool !== 'scale') setCalNodes([])
  }, [tool])

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

  // leaving the metre-entry popover returns to Messen (the auto-calibrate-on-first-measure
  // flow), otherwise drops to pan (the Maßstab chip).
  const closeCalPrompt = () => { setCalPrompt(null); setTool(tool === 'measure' ? 'measure' : 'pan') }
  // commit the metre-entry popover: derive + persist the calibration factor for this plan
  const commitCalibration = (refM: number) => {
    if (!calPrompt) return
    const a = toMeasurePt(calPrompt.a), b = toMeasurePt(calPrompt.b)
    const sc = calibrate(a, b, refM, measureAR)
    closeCalPrompt()
    if (!sc) return
    setLastRefM(refM)
    onCalibrate?.(activeId, sc)
    log('measure', fillTemplate(appConfig.copy.whiteboard.scale.saved, { m: String(refM) }))
    toast(fillTemplate(appConfig.copy.whiteboard.scale.saved, { m: String(refM) }))
    if (onCalibrate) setSavePrompt(sc) // editor: offer to remember it across incidents
  }

  return {
    calNodes, setCalNodes, calPrompt, setCalPrompt, lastRefM, refMInput, setRefMInput, savePrompt, setSavePrompt,
    measMode, setMeasMode, measLine, setMeasLine, measArea, setMeasArea,
    measureAR, activeScale, scaleStale, calibrated, planMetres, toMeasurePt,
    measPath, setMeasPath, measMpts, measLenM, measAreaM2, measPerimM, measReset, resetEphemeral,
    measNodeDown, measMove, measUp, measDragging, measInsert, measDelete, measPress,
    closeCalPrompt, commitCalibration,
  }
}
