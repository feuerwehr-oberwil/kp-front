import { ApiError, apiGet, apiPut } from './api'
import { idbGet, idbSet } from './idb'
import { arDrifted, isStale, type PlanScale } from './planScale'
import { onLinkPage } from './linkMode'
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
  /**
   * georefKey → the sheet's MEASURED aspect ratio (width / height), written by a surface that has
   * actually rendered the bitmap. Who writes it, and when, is `noteMeasuredAspect` below.
   *
   * ⚠️ WHY THIS IS NOT `PlanScale.ar`, which is the same quantity by name.
   *
   * `ar` is not a free-standing statement about the paper: it is one half of a PAIR. A calibration
   * says «`mPerU` metres per aspect-corrected unit, derived at aspect `ar`», and the sheet's ground
   * width is the PRODUCT `ar · mPerU` (georefTwins · planGroundWidthM). Correcting `ar` inside a
   * stored calibration would therefore silently rescale that plan: every `sizeN`, `reachN`,
   * `radiusN` and measured distance on it changes by the same ratio, and the operator's «20 m» — a
   * number somebody read off a printed scale bar — quietly becomes 21 m. `ar` may only ever change
   * together with the `mPerU` it was measured against, which is what re-calibrating does and what
   * `isStale` exists to demand.
   *
   * The measured aspect is the OTHER kind of statement: «this sheet is this shape», full stop, with
   * no factor attached. It is what the georeference fit has to be SOLVED in (georefTwins ·
   * planAspect), and correcting it re-solves the fit from the SAME landmark pairs — a pair is an
   * aspect-independent claim that a point on the paper is a point on the ground, so a truer aspect
   * can only make the fit truer. Nothing is rescaled behind anybody's back: the calibration is left
   * exactly as it was, the fit moves, and the re-bake says so in the Verlauf.
   *
   * Hence its own field. A stored `ar` that disagrees with it is not corrected here — it is stale,
   * and `isStale` already says so where staleness matters.
   */
  measuredArByPlan: Record<string, number>
}

/** What the endpoint answers with: the document, plus the token of the version it was read at
 *  (backend app/api/plan_scales.py · `PlanScalesOut`). The token is deliberately NOT part of
 *  `StationPlanScales` — `normalize` drops it — so a read-modify-write can never store one. */
interface StationPlanScalesWire extends Partial<StationPlanScales> { version?: string }

const EMPTY: StationPlanScales = { default: null, byPlan: {}, georefByPlan: {}, measuredArByPlan: {} }
const CACHE_KEY = 'kp-front-plan-scales'

/** Fill in every field, whatever the source left out — the server document, and just as much a
 *  cache entry written before `georefByPlan` (or `measuredArByPlan`) existed, must both come out
 *  fully shaped. */
function normalize(v: Partial<StationPlanScales> | null | undefined): StationPlanScales {
  if (!v || typeof v !== 'object') return EMPTY
  return {
    default: v.default ?? null,
    byPlan: v.byPlan ?? {},
    georefByPlan: v.georefByPlan ?? {},
    measuredArByPlan: v.measuredArByPlan ?? {},
  }
}

let resolved: StationPlanScales = EMPTY

/**
 * The version of the STORED document this device last saw, sent back as `If-Match` on the next
 * PUT (backend app/api/plan_scales.py · put_plan_scales).
 *
 * ⚠️ Null means «we have no idea what the server holds», and that is a real state, not a bug: an
 * offline boot resolves out of the IDB cache, which is a document the server confirmed at some
 * point but says nothing about now. A write then goes out unguarded — the endpoint still accepts
 * one, deliberately — because refusing it would mean a Georeferenz that cannot be saved in the
 * field, which is the thing this document exists for.
 */
let version: string | null = null

/** Take a server answer as THE document: the singleton, the offline cache, the version token and
 *  the «a real document has landed» flag all move together. Returns whether anything actually
 *  changed, so a refresh that brought nothing new costs no re-render — the caller decides whether
 *  to notify. The cache is refilled either way, and deliberately: an answer identical to what is
 *  in memory is not necessarily what is on disk, and a station whose document is empty has to be
 *  cacheable too or an offline boot would go on knowing nothing at all. */
function adopt(wire: StationPlanScalesWire | null | undefined): boolean {
  const next = normalize(wire)
  version = wire?.version ?? null
  const changed = JSON.stringify(next) !== JSON.stringify(resolved)
  resolved = next
  loaded = true
  void idbSet(CACHE_KEY, next)
  return changed
}

/** Has a REAL document ever landed in `resolved` — from the server, or from the offline cache
 *  that the server once filled? ⚠️ `resolved` is EMPTY both before the boot load and after a load
 *  that found nothing anywhere, and those two states are worlds apart: «this station has no
 *  calibration yet» may be written on top of, «we never found out» may not. See `baseForWrite`. */
let loaded = false

/** Has a real document landed yet (server or the cache the server once filled)? The same
 *  distinction `baseForWrite` guards a WRITE with, exposed for readers that are about to DERIVE
 *  something persistent from a georeference — an empty singleton and «this station has none» are
 *  worlds apart, and baking map positions out of the first would store a picture built on a
 *  document nobody has read. */
export function stationPlanScalesLoaded(): boolean {
  return loaded
}

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

/**
 * Read-modify-write, with the ONE recovery a stale token deserves.
 *
 * `change` is a per-plan merge in every caller — it adds or removes one key of `byPlan` /
 * `georefByPlan` and hands the rest of the document straight back — so a 409 («somebody stored a
 * newer document between our read and our PUT») is not a failure at all: it is an instruction to
 * take THEIR document and apply the same one-key change on top of it. That is why the recovery
 * re-runs `change` rather than re-sending the body we built, which would clobber exactly what the
 * token was there to protect.
 *
 * Once, and once only. A second 409 means two devices are writing this document faster than a
 * round trip, and the honest answer to that is the caller's own «… fehlgeschlagen» rather than a
 * loop that eventually lands on whichever of them retried last.
 */
function updateStationPlanScales(change: (current: StationPlanScales) => StationPlanScales): Promise<void> {
  const update = updateTail.catch(() => {}).then(async () => {
    const current = await baseForWrite()
    try {
      await saveStationPlanScales(change(current))
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e
      const fresh = await rereadForConflict()
      if (!fresh) throw e
      await saveStationPlanScales(change(fresh))
    }
  })
  updateTail = update
  return update
}

/**
 * The re-read a refused write recovers on — and NOT `loadStationPlanScales`.
 *
 * That one falls back to the IDB cache, which is precisely the wrong answer here: we are
 * recovering from the server saying «you are out of date», and a cached document is by definition
 * not the one it refused us over. A re-read that cannot reach the server therefore returns null
 * and the original 409 stands, leaving the optimistic local document alone rather than replacing
 * it with something older still.
 */
async function rereadForConflict(): Promise<StationPlanScales | null> {
  try {
    const wire = await apiGet<StationPlanScalesWire>('/api/plan-scales')
    if (!wire?.version) return null // an endpoint that names no version cannot settle a conflict
    if (adopt(wire)) notify()
    return resolved
  } catch {
    return null
  }
}

export async function loadStationPlanScales(): Promise<StationPlanScales> {
  try {
    if (adopt(await apiGet<StationPlanScalesWire>('/api/plan-scales'))) notify()
    return resolved
  } catch {
    // A cache HIT is a real document too — it is the last one the server confirmed to this
    // device. A miss (or an IDB that refuses to open) leaves us knowing nothing at all, and
    // `loaded` has to stay false so that no read-modify-write builds on the void.
    const cached = await idbGet<StationPlanScales>(CACHE_KEY).catch(() => null)
    const changed = JSON.stringify(normalize(cached)) !== JSON.stringify(resolved)
    resolved = normalize(cached)
    loaded = !!cached
    // ⚠️ …and SAY so. A reader that is waiting for a real document before deriving anything from
    // it (IncidentWorkspace's seed bake) has nothing else to re-run on, and a cache hit IS a real
    // document — silently swallowing it left that reader waiting for a load that had landed.
    if (changed || loaded) notify()
    return resolved
  }
}

/**
 * ⚠️ A refused write has just PUT THE OLD DOCUMENT BACK, and the surfaces have to be told which
 * of the two things that look identical from outside actually happened.
 *
 * The rollback below restores `resolved` and notifies, and a notify is all a reader ever sees. So
 * the fit-change reader (IncidentWorkspace) watched the reference change to the operator's value,
 * wrote the row and the undo step for it, and then watched it change BACK — which, read by the
 * pairs alone, is a second correction by a second hand. It journalled «Referenz angepasst» twice
 * and offered a ↶ for an act that had already been undone by the server refusing it.
 *
 * A flag, not a third signature: the rollback is the ONE cause that cannot be read off the
 * document, because the document it leaves behind is exactly the one that was there before.
 * Set here, taken by the next reader, and consumed by the taking — a refused Massstab write, which
 * changes no fit and therefore produces no row, must not leave it armed for the next real
 * correction.
 */
let rolledBack = false

/** Did the last notification come from a REFUSED write being rolled back? Consumes the flag. */
export function takeRolledBackStationWrite(): boolean {
  const was = rolledBack
  rolledBack = false
  return was
}

/** Persist the full document (editor). Updates the singleton + cache so reads see it at once.
 *  ⚠️ The PUT REPLACES the stored document — the server keeps no field it isn't sent. Every
 *  writer therefore read-modify-writes on top of `baseForWrite()`, as the helpers below do;
 *  building a body from scratch would drop whatever the other half of the document holds.
 *
 *  ⚠️ It carries `If-Match`, and a stale token comes back as a 409 that this function does NOT
 *  handle — `updateStationPlanScales` does, because recovering means re-applying the caller's
 *  change onto the document the server actually holds, and only the caller's `change` knows how.
 *  A direct caller therefore gets the 409, which is the honest thing to hand a writer that
 *  replaced the whole document on purpose. */
export async function saveStationPlanScales(next: StationPlanScales): Promise<void> {
  // ⚠️ …and what to go back to when it does NOT land. The write is optimistic — the singleton and
  // the offline cache are moved first, so the surfaces show the operator's change at once — and
  // without this the REFUSED document simply stayed the local truth. The operator was told
  // «fehlgeschlagen», the sheet went on showing the reference the server had rejected, a reload
  // adopted it back out of the cache, and the next unrelated save (a Massstab on some other plan)
  // read-modify-wrote on top of it and smuggled the refused georeference into the stored document
  // as a side effect of something else.
  const before = resolved
  writeSeq++
  resolved = next
  void idbSet(CACHE_KEY, next)
  notify()
  // ⚠️ The token is read INSIDE the queued step, not when the write was scheduled: two writes in
  // quick succession are ordered by this very chain, and the second one's base is the document
  // the first one just stored — so it has to send the token that write came back with, or it
  // would refuse itself.
  const write = writeTail.catch(() => {}).then(async () => {
    try {
      const res = await apiPut<StationPlanScalesWire>('/api/plan-scales', next, version ? { 'If-Match': version } : undefined)
      version = res?.version ?? null
    } catch (e) {
      // ⚠️ Only if OURS is still the document standing. A later write may already have replaced
      // it, and putting this one's base back would then revert somebody else's landed change.
      if (resolved === next) {
        resolved = before
        void idbSet(CACHE_KEY, before)
        // …and SAY that this notification is a rollback, BEFORE it goes out: it is the notify
        // that re-runs the fit reader, and that reader decides from this flag whether an
        // operator corrected a reference or a save failed (see `rolledBack` above).
        rolledBack = true
        notify()
      }
      // ⚠️ `version` is deliberately NOT rolled back: it is only ever advanced by a PUT that
      // came back, so a refusal has not touched it. Restoring it here would instead undo the
      // token of a concurrent write that DID land. And if the server committed while the answer
      // was lost, the token we keep is merely stale — the next write's 409 re-reads and
      // re-applies, which is the path that already exists.
      throw e
    }
  })
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
  let wire: StationPlanScalesWire
  try {
    wire = await apiGet<StationPlanScalesWire>('/api/plan-scales')
  } catch {
    return
  }
  // a local write started while the GET was in the air — its body is newer than this answer, and
  // so is the token it came back with
  if (writeSeq !== seenWrites) return
  if (adopt(wire)) notify()
}

/**
 * The document a read-modify-write may safely build on — or a rejection.
 *
 * ⚠️ THE TRAP this exists for. `getStationPlanScales()` hands back the EMPTY singleton until the
 * boot load resolves, and `loadStationPlanScales` lands on EMPTY as well when the GET failed and
 * the IDB cache was cold — offline in the field, or a 500. The PUT above then REPLACES the whole
 * stored document, and `plan_scales_json` keeps no history and no backup. So a writer that merges
 * onto that void ships
 * `{default: null, byPlan: {}, georefByPlan: {…}}` and deletes the station's default Massstab
 * and every per-plan override — on every device, unrecoverably, from one georeference.
 *
 * «Loaded and genuinely empty» is fine to build on; «never loaded» is not, and only the second
 * is blocked here. Since the operator is by definition online-or-not at this exact moment and
 * not at boot, the first move is simply to try the GET again; if that fails too the write is
 * REFUSED loudly, so the caller can raise the app's save-failed toast instead of destroying a
 * document it never read.
 *
 * ⚠️ The If-Match guard does NOT cover this case and cannot: a device that never read the
 * document holds no version token either, so its write goes out unguarded and the server has
 * nothing to compare. The token protects a stale reader; this protects a blind one, and both are
 * needed.
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

// --- the sheet's measured shape --------------------------------------------------------------

/** The measured aspect (width / height) stored for one concrete sheet, or undefined. ⚠️
 *  `georefKey`, not a `planId` — see `georefForPlan`; the bitmap belongs to one Einsatzobjekt's
 *  sheet, not to the Modul slot every object shares. */
export function measuredArForPlan(georefKey: string): number | undefined {
  const ar = getStationPlanScales().measuredArByPlan[georefKey]
  return ar && ar > 0 ? ar : undefined
}

/** The plans whose measured aspect this session has already settled — so a surface may ask on
 *  every render and a sheet is written at most once per session. Module-level, like the document
 *  itself: opening the same plan twice is the same answer. */
const notedAspects = new Set<string>()

/**
 * «This sheet is this shape» — offered by whichever surface has actually RENDERED the bitmap, and
 * stored only when it disagrees with what the app is currently fitting through.
 *
 * ⚠️ The hole this closes. A georeference is solved in the isotropic space `(x·ar, y)`, and the
 * `ar` the app shell can reach is recovered from the plan's stored CALIBRATION (georefTwins ·
 * planAspect) — which is exactly the number that goes stale when a Modul PDF is replaced by a
 * differently-shaped sheet. Worse, it cannot be caught by staleness: `isStale` asks whether a
 * calibration still matches the current aspect, and the current aspect is the very thing being
 * looked for. The pairs cannot disagree with it either — they were fitted at the same wrong
 * aspect, so the residuals stay near zero. While the fit only drew twins that was a tilted
 * picture; now that fit is BAKED into every symbol standing on the sheet, so it is a wrong
 * position in the record.
 *
 * The measuring surface is the only cure, so it says so once and the station document remembers.
 *
 * · `effective` is what `planAspect` currently answers for this sheet. Nothing is written while
 *   the two agree — and since a stored measurement wins that resolution, the write settles the
 *   question rather than repeating it.
 * · The threshold is `arDrifted` — the SAME 2 % «this is a different sheet» the calibration's own
 *   staleness uses (lib/planScale · AR_DRIFT_TOL). Below it lies the A4 seed's rounding and float
 *   noise, and a re-bake for a tenth of a percent would be a Verlauf row about nothing.
 * · Once per sheet per session, and never from a read-only session: deriving the picture is
 *   everybody's, writing into the record is an editor's. ⚠️ …and never from a handed-over LINK
 *   page either, which is the half the calling surface cannot see. A link is given to somebody
 *   for one job — watch this Atemschutz board, look at this Einsatz — and none of those jobs is
 *   «reshape the station's plans». The Atemschutz link's PUT was refused by the server anyway, so
 *   this attempted a write it knew would fail; a VIEW link on a device that happens to be signed
 *   in as an editor would have been allowed, which is the one that matters.
 *
 * Rejections are swallowed: this is a correction the app noticed on its own, not something the
 * operator asked for, and it must never raise a «… fehlgeschlagen» over a sheet somebody merely
 * opened. It will be offered again next session.
 */
export function noteMeasuredAspect(georefKey: string, measured: number, effective: number): void {
  if (!(measured > 0) || notedAspects.has(georefKey) || onLinkPage()) return
  if (!arDrifted(effective, measured)) return
  notedAspects.add(georefKey)
  void updateStationPlanScales((cur) => ({
    ...cur, measuredArByPlan: { ...cur.measuredArByPlan, [georefKey]: measured },
  })).catch(() => { notedAspects.delete(georefKey) })
}

/** Test seam — forgets which sheets this session has already settled. */
export function resetMeasuredAspectSession(): void {
  notedAspects.clear()
}
