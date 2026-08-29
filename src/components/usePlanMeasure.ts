import { useEffect, useState } from 'react'
import { calibrate, pathMetres, isStale, type PlanScale } from '../lib/planScale'
import { resolvePlanScale } from '../lib/stationPlanScale'
import { TILE_AR } from '../lib/whiteboard'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
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
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  onCalibrate?: (planId: string, scale: PlanScale | null) => void
  /** A DERIVED metre factor — a finished map↔plan fit, or (on a georeferenced Gebäude, A7) the
   *  footprint's own ground size via lib/footprint · stackScaleMPerU. Never stored as a second
   *  calibration; sits below an incident-specific manual reference but above a station fallback. */
  autoScale?: PlanScale
}

/**
 * Plan-Maßstab (calibration): the one domain on the whiteboard that owns its own state end to
 * end — nothing here is ever written to the board document, and nothing outside reads it except
 * the prompt/chip that drive it and the metric read-outs (`planMetres`, DrawEditor's Messung).
 *
 * ⚠️ The Messen TOOL was removed from the Plan on 29.08. — a DELIBERATE Lage↔Plan divergence,
 * not drift: on a plan every distance worth keeping is a drawn Linie/Fläche, whose Messung
 * section and distance labels read through this calibration, so the ephemeral measure path only
 * duplicated the drawing tools with state that vanished on tap-away. Don't "fix" the tool back
 * in. The calibration half stays because it feeds those read-outs and the georef autoScale.
 */
export function usePlanMeasure({ activeId, stack, aspect, planScale, localY, floorAt, tool, setTool, log, onCalibrate, autoScale }: Args) {
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

  // Measurement is aspect-corrected: a normalized segment's true length depends on the plan's
  // aspect ratio (width / height). On a single sheet that's 1/aspect; on a floor-stack each storey
  // TILE is measured in its own space (1/TILE_AR), so one calibration covers every floor of the
  // same drawing. The reference drag and stored line `pts` live in this same space.
  const measureAR = stack ? 1 / TILE_AR : 1 / aspect
  // Resolve through the STATION calibration (per-incident → per-plan override → station default),
  // so a plan measures out of the box without re-calibrating each incident (#3). A field
  // calibration for this incident still wins; a stale candidate falls through.
  const workspaceScale: PlanScale | undefined = planScale[activeId]
  const validWorkspaceScale = workspaceScale && !isStale(workspaceScale, measureAR) ? workspaceScale : undefined
  const activeScale: PlanScale | undefined = validWorkspaceScale ?? autoScale ?? resolvePlanScale(activeId, undefined, measureAR)
  const scaleAuto = !!autoScale && activeScale === autoScale
  const scaleStale = !!workspaceScale && isStale(workspaceScale, measureAR) && !activeScale
  const calibrated = !!activeScale
  // metres of a stored polyline (tile-local pts already, for a floor-stack) under the calibration
  const planMetres = (pts: Pt[]): number | null =>
    calibrated && activeScale ? pathMetres(pts, activeScale.mPerU, measureAR) : null
  // convert a board-normalized point into the measurement space (tile-local y on a floor-stack)
  const toMeasurePt = (n: Pt): Pt => stack ? [n[0], localY(n[1], floorAt(n[1]))] : n

  /** everything this hook owns that must not survive a document switch */
  const resetEphemeral = () => { setCalNodes([]); setCalPrompt(null) }

  // a half-laid Maßstab tap is ephemeral, so clear it when leaving the tool
  useEffect(() => {
    if (tool !== 'scale') setCalNodes([])
  }, [tool])

  // leaving the metre-entry popover drops to pan (the Maßstab chip is how it was armed)
  const closeCalPrompt = () => { setCalPrompt(null); setTool('pan') }
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
    measureAR, activeScale, scaleAuto, scaleStale, calibrated, planMetres, toMeasurePt, resetEphemeral,
    closeCalPrompt, commitCalibration,
  }
}
