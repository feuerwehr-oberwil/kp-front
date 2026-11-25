import type { Dispatch, SetStateAction } from 'react'
import type { PlanScale } from '../lib/planScale'
import type { PlanScales } from '../lib/workspace'
import { recordKey, type RecordKey } from '../lib/undoKeys'
import type { Dropper, UndoDomain } from '../lib/undoTimeline'
import type { OneShotRows } from './types'

/** IncidentWorkspace · rememberOneShot, as this module needs it */
type RememberOneShot = (domain: UndoDomain, label: string, restore: () => void, reapply: () => void,
  touches: () => readonly RecordKey[] | null, rows?: OneShotRows | 'silent') => Dropper

/** One plan's hand calibration put into the incident's scale map; `null` takes the plan's key out. */
function putScale(m: PlanScales, planId: string, sc: PlanScale | null): PlanScales {
  if (sc) return { ...m, [planId]: sc }
  const { [planId]: _drop, ...rest } = m
  return rest
}

/**
 * A hand calibration of one plan (Whiteboard · usePlanMeasure · commitCalibration), written as a
 * workspace one-shot on the `planScale:<planId>` record: ↶ puts back `before`, ↷ the new scale.
 * Returns the calibration toast's «Rückgängig»: it takes the same step back, and answers `false`
 * once the step no longer stands — taken by ↶, or dropped by a merge that brought another
 * device's newer scale for this plan.
 *
 * ⚠️ The toast used to put `before` back unconditionally, so on a first calibration it deleted a
 * newer scale another tablet had set meanwhile (hunt 24.11.2026, frontend-state F9).
 */
export function calibratePlan(planId: string, sc: PlanScale, deps: {
  /** what this incident had for the plan before — the hand calibration it replaces, or none */
  before: PlanScale | null
  setPlanScale: Dispatch<SetStateAction<PlanScales>>
  remember: RememberOneShot
  /** the act's own words, «Massstab kalibriert (10 m Strecke)» — the ↶ caption */
  label: string
  /** the act's counter-rows, in its own words */
  rows: OneShotRows
}): () => boolean {
  const { before, setPlanScale, remember, label, rows } = deps
  const write = (v: PlanScale | null) => setPlanScale((m) => putScale(m, planId, v))
  write(sc)
  const step = remember('plan', label, () => write(before), () => write(sc), () => [recordKey('planScale', planId)], rows)
  return () => {
    if (!step.standing()) return false
    step()
    write(before)
    rows.undo()
    return true
  }
}
