import { apiGet, apiPut } from './api'
import { idbGet, idbSet } from './idb'
import { isStale, type PlanScale } from './planScale'

/**
 * STATION-level plan calibration, persisted across incidents/devices (editor-authored via
 * `/api/plan-scales`). A station's plans share one generator/layout, so one `default`
 * calibration usually fits every plan; `byPlan` holds the exceptions. This is the persistent
 * layer BELOW the per-incident workspace `planScale` — so a plan measures out of the box
 * without re-calibrating each incident. See src/lib/planScale.ts for the factor model and
 * the backend app/api/plan_scales.py.
 */
export interface StationPlanScales {
  default: PlanScale | null
  byPlan: Record<string, PlanScale>
}

const EMPTY: StationPlanScales = { default: null, byPlan: {} }
const CACHE_KEY = 'kp-front-plan-scales'

let resolved: StationPlanScales = EMPTY

/** Synchronous accessor — {} until load resolves; safe to read early (callers fall back). */
export function getStationPlanScales(): StationPlanScales {
  return resolved
}

/** Fetch the station calibration (PUBLIC GET), cache for offline, populate the singleton.
 *  Never throws — a failure just means no station default (plans fall back to «calibrate»). */
export async function loadStationPlanScales(): Promise<StationPlanScales> {
  try {
    const v = await apiGet<StationPlanScales>('/api/plan-scales')
    resolved = v && typeof v === 'object' ? { default: v.default ?? null, byPlan: v.byPlan ?? {} } : EMPTY
    void idbSet(CACHE_KEY, resolved)
    return resolved
  } catch {
    resolved = (await idbGet<StationPlanScales>(CACHE_KEY)) ?? EMPTY
    return resolved
  }
}

/** Persist the full document (editor). Updates the singleton + cache so reads see it at once. */
export async function saveStationPlanScales(next: StationPlanScales): Promise<void> {
  resolved = next
  void idbSet(CACHE_KEY, next)
  await apiPut('/api/plan-scales', next)
}

/** Save the given calibration as the station default (all uncalibrated plans). */
export function saveStationDefault(scale: PlanScale): Promise<void> {
  return saveStationPlanScales({ ...getStationPlanScales(), default: scale })
}

/** Save a persistent per-plan override (this plan, every incident). */
export function saveStationPlanOverride(planId: string, scale: PlanScale): Promise<void> {
  const cur = getStationPlanScales()
  return saveStationPlanScales({ ...cur, byPlan: { ...cur.byPlan, [planId]: scale } })
}

/**
 * Resolve the effective calibration for a plan at the given aspect ratio, in priority order:
 *   per-incident workspace  →  station per-plan override  →  station default.
 * A candidate that's stale for the current aspect (image replaced/resized) is skipped so the
 * caller falls through to the next layer (or ultimately «calibrate»).
 */
export function resolvePlanScale(
  planId: string,
  workspaceScale: PlanScale | undefined,
  ar: number,
): PlanScale | undefined {
  const station = getStationPlanScales()
  for (const cand of [workspaceScale, station.byPlan[planId], station.default ?? undefined]) {
    if (cand && !isStale(cand, ar)) return cand
  }
  return undefined
}
