import { apiGet, apiPut } from './api'
import { idbGet, idbSet } from './idb'
import { isStale, type PlanScale } from './planScale'
import type { Georef } from './georef'

/**
 * STATION-level plan calibration, persisted across incidents/devices (editor-authored via
 * `/api/plan-scales`). A station's plans share one generator/layout, so one `default`
 * calibration usually fits every plan; `byPlan` holds the exceptions. This is the persistent
 * layer BELOW the per-incident workspace `planScale` — so a plan measures out of the box
 * without re-calibrating each incident. See src/lib/planScale.ts for the factor model and
 * the backend app/api/plan_scales.py.
 *
 * The same document also carries each plan's GEOREFERENCE (`georefByPlan`) — the landmark
 * point-pairs that tie the sheet to the map (src/lib/georef.ts). It belongs here for the same
 * reason and by the same rules: a house corner is where it is regardless of which incident is
 * running, it is editor-authored in the field, and it must be cached offline at boot. One
 * document, one endpoint, one load — never a second fetch of the same thing.
 */
export interface StationPlanScales {
  default: PlanScale | null
  byPlan: Record<string, PlanScale>
  /** georefKey → georeference (`PlanDocument.georefKey`, i.e. one concrete Einsatzobjekt's sheet
   *  — NOT the reusable Modul `planId`). A sheet absent here is simply not georeferenced. */
  georefByPlan: Record<string, Georef>
}

const EMPTY: StationPlanScales = { default: null, byPlan: {}, georefByPlan: {} }
const CACHE_KEY = 'kp-front-plan-scales'

/** Fill in every field, whatever the source left out — the server document, and just as much a
 *  cache entry written before `georefByPlan` existed, must both come out fully shaped. */
function normalize(v: Partial<StationPlanScales> | null | undefined): StationPlanScales {
  if (!v || typeof v !== 'object') return EMPTY
  return { default: v.default ?? null, byPlan: v.byPlan ?? {}, georefByPlan: v.georefByPlan ?? {} }
}

let resolved: StationPlanScales = EMPTY

/** Has a REAL document ever landed in `resolved` — from the server, or from the offline cache
 *  that the server once filled? ⚠️ `resolved` is EMPTY both before the boot load and after a load
 *  that found nothing anywhere, and those two states are worlds apart: «this station has no
 *  calibration yet» may be written on top of, «we never found out» may not. See `baseForWrite`. */
let loaded = false

/** Synchronous accessor — {} until load resolves; safe to READ early (callers fall back).
 *  ⚠️ Never a merge base for a write: that is `baseForWrite`, and the difference is a wiped
 *  station document. */
export function getStationPlanScales(): StationPlanScales {
  return resolved
}

/** Fetch the station calibration (PUBLIC GET), cache for offline, populate the singleton.
 *  Never throws — a failure just means no station default (plans fall back to «calibrate»). */
export async function loadStationPlanScales(): Promise<StationPlanScales> {
  try {
    resolved = normalize(await apiGet<StationPlanScales>('/api/plan-scales'))
    loaded = true
    void idbSet(CACHE_KEY, resolved)
    return resolved
  } catch {
    // A cache HIT is a real document too — it is the last one the server confirmed to this
    // device. A miss (or an IDB that refuses to open) leaves us knowing nothing at all, and
    // `loaded` has to stay false so that no read-modify-write builds on the void.
    const cached = await idbGet<StationPlanScales>(CACHE_KEY).catch(() => null)
    resolved = normalize(cached)
    loaded = !!cached
    return resolved
  }
}

/** Persist the full document (editor). Updates the singleton + cache so reads see it at once.
 *  ⚠️ The PUT REPLACES the stored document — the server keeps no field it isn't sent. Every
 *  writer therefore read-modify-writes on top of `baseForWrite()`, as the helpers below do;
 *  building a body from scratch would drop whatever the other half of the document holds. */
export async function saveStationPlanScales(next: StationPlanScales): Promise<void> {
  resolved = next
  void idbSet(CACHE_KEY, next)
  await apiPut('/api/plan-scales', next)
}

/**
 * The document a read-modify-write may safely build on — or a rejection.
 *
 * ⚠️ THE TRAP this exists for. `getStationPlanScales()` hands back the EMPTY singleton until the
 * boot load resolves, and `loadStationPlanScales` lands on EMPTY as well when the GET failed and
 * the IDB cache was cold — offline in the field, or a 500. The PUT above then REPLACES the whole
 * stored document, `/api/plan-scales` has no If-Match guard, and `plan_scales_json` keeps no
 * history and no backup. So a writer that merges onto that void ships
 * `{default: null, byPlan: {}, georefByPlan: {…}}` and deletes the station's default Massstab
 * and every per-plan override — on every device, unrecoverably, from one georeference.
 *
 * «Loaded and genuinely empty» is fine to build on; «never loaded» is not, and only the second
 * is blocked here. Since the operator is by definition online-or-not at this exact moment and
 * not at boot, the first move is simply to try the GET again; if that fails too the write is
 * REFUSED loudly, so the caller can raise the app's save-failed toast instead of destroying a
 * document it never read.
 */
async function baseForWrite(): Promise<StationPlanScales> {
  if (loaded) return resolved
  await loadStationPlanScales()
  if (!loaded) throw new Error('plan-scales: refusing to overwrite a document that never loaded')
  return resolved
}

/** Save the given calibration as the station default (all uncalibrated plans). */
export async function saveStationDefault(scale: PlanScale): Promise<void> {
  return saveStationPlanScales({ ...(await baseForWrite()), default: scale })
}

/** Save a persistent per-plan override (this plan, every incident). */
export async function saveStationPlanOverride(planId: string, scale: PlanScale): Promise<void> {
  const cur = await baseForWrite()
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

// --- Georeferenz (map ⇄ plan) ---------------------------------------------------------------

/** The stored georeference of one concrete sheet, or null when it has none. ⚠️ `georefKey`, not
 *  a `planId`: types.ts · PlanDocument.georefKey exists because a `planId` is a reusable Modul
 *  slot shared by every Einsatzobjekt, so keying on it would hand back another building's
 *  reference. Synchronous, like the scale accessors: null until the boot load resolves, and
 *  callers already fall back to «not georeferenced». Pairs are raw — feed them to
 *  `fitSimilarity` with the plan's aspect ratio. */
export function georefForPlan(georefKey: string): Georef | null {
  return getStationPlanScales().georefByPlan[georefKey] ?? null
}

/** Persist one sheet's georeference (editor), read-modify-write on the shared document.
 *  An EMPTY pair list removes the entry rather than storing a hollow one — that is «Referenz
 *  zurücksetzen», and it keeps «has a georeference» a single question with a single answer.
 *  ⚠️ `georefKey`, not a `planId` — see `georefForPlan`. The merge base comes from
 *  `baseForWrite`, which is where the never-loaded trap is handled: this REJECTS rather than
 *  writing a georeference over a station document it could not read. */
export async function saveGeoref(georefKey: string, georef: Georef): Promise<void> {
  const cur = await baseForWrite()
  const georefByPlan = { ...cur.georefByPlan }
  if (georef.pairs.length) georefByPlan[georefKey] = georef
  else delete georefByPlan[georefKey]
  return saveStationPlanScales({ ...cur, georefByPlan })
}
