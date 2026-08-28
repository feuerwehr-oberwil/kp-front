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
// --- change notification --------------------------------------------------------------------
// `resolved` is a module singleton read synchronously (getStationPlanScales / georefForPlan /
// resolvePlanScale), so a surface showing a station calibration has nothing to re-render on when
// the document changes underneath it. These listeners are that something; lib/georefMode wires
// its own version counter to them, which is what `useGeorefStorage` already subscribes to.
const listeners = new Set<() => void>()

/** Subscribe to «the station document changed» — a local write, or a refresh that brought
 *  something new down from the server. Returns the unsubscribe. */
export function subscribeStationPlanScales(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const notify = () => listeners.forEach((l) => l())

/** Bumped by every write, so a GET that was already in the air when a local save started cannot
 *  land on top of it with the server's older answer. */
let writeSeq = 0

/** The endpoint replaces the WHOLE document. Keep writes in call order so linking several
 *  Modules in quick succession cannot let a slower, older PUT land after the newer aggregate
 *  and erase it. Rejections are swallowed only by the chain itself; each caller still receives
 *  its own failure, while the next queued write remains able to run. */
let writeTail: Promise<void> = Promise.resolve()

/** Serialize the read-modify-write as one transaction too. Serializing only the PUT is not
 *  enough: two callers can otherwise both read the same base before either has added its Modul,
 *  producing two perfectly ordered writes whose second body still omits the first change. */
let updateTail: Promise<void> = Promise.resolve()

function updateStationPlanScales(change: (current: StationPlanScales) => StationPlanScales): Promise<void> {
  const update = updateTail.catch(() => {}).then(async () => {
    const current = await baseForWrite()
    await saveStationPlanScales(change(current))
  })
  updateTail = update
  return update
}

export async function loadStationPlanScales(): Promise<StationPlanScales> {
  try {
    const next = normalize(await apiGet<StationPlanScales>('/api/plan-scales'))
    const changed = JSON.stringify(next) !== JSON.stringify(resolved)
    resolved = next
    loaded = true
    void idbSet(CACHE_KEY, resolved)
    if (changed) notify()
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
  writeSeq++
  resolved = next
  void idbSet(CACHE_KEY, next)
  notify()
  const write = writeTail.catch(() => {}).then(() => apiPut('/api/plan-scales', next).then(() => undefined))
  writeTail = write
  await write
}

/**
 * Re-read the station document from the server.
 *
 * ⚠️ This is the ONLY way a device that is ALREADY RUNNING learns about a Massstab or a
 * Georeferenz somebody set on another device. The boot load (main.tsx) runs exactly once and
 * nothing polls, so a plan referenced on the KP tablet used to reach the phone in the same
 * Einsatz only after the phone was restarted — and the whole point of this document is that it
 * is station data, not device data.
 *
 * Deliberately quieter than the boot load: a failed fetch keeps whatever we have (a refresh must
 * never degrade a good document into the offline void), and an answer identical to what is
 * already resolved notifies nobody, so a periodic check costs no re-render at all.
 */
export async function refreshStationPlanScales(): Promise<void> {
  const seenWrites = writeSeq
  let next: StationPlanScales
  try {
    next = normalize(await apiGet<StationPlanScales>('/api/plan-scales'))
  } catch {
    return
  }
  // a local write started while the GET was in the air — its body is newer than this answer
  if (writeSeq !== seenWrites) return
  loaded = true
  if (JSON.stringify(next) === JSON.stringify(resolved)) return
  resolved = next
  void idbSet(CACHE_KEY, next)
  notify()
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
  return updateStationPlanScales((cur) => ({ ...cur, default: scale }))
}

/** Save a persistent per-plan override (this plan, every incident). */
export async function saveStationPlanOverride(planId: string, scale: PlanScale): Promise<void> {
  return updateStationPlanScales((cur) => ({ ...cur, byPlan: { ...cur.byPlan, [planId]: scale } }))
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
  return updateStationPlanScales((cur) => {
    const georefByPlan = { ...cur.georefByPlan }
    if (georef.pairs.length) georefByPlan[georefKey] = georef
    else delete georefByPlan[georefKey]
    return { ...cur, georefByPlan }
  })
}
