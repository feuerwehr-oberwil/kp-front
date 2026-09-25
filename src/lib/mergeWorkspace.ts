// Three-way merge of two divergent workspace blobs against their common ancestor (the last
// revision both devices shared). This is what turns concurrent multi-device editing from
// "one whole snapshot wins, the other's work is lost" into a real merge, the way Miro/Figma
// resolve it:
//   - independent additions to different objects all survive (ordered by server appearance);
//   - edits to the SAME object are last-writer-wins (the device flushing later wins) — except
//     Trupps, which merge field-level (mergeTrupp) because an SCBA record must never lose a
//     pressure reading to a concurrent radio contact;
//   - a delete BEATS a concurrent edit — the object stays gone, no resurrection.
//
// The `base` ancestor is the crux: it lets us tell "I deleted X" (present in base, absent in
// mine) apart from "I never had X" (absent in both base and mine). Without it a naive union
// can't honor deletes and would resurrect everything the other device removed.

import { objectsFromLegacy, viewsOf, type ObjectViews, type TacticalObject } from './tacticalObjects'
import { mergeIncidentPlanBindings, type IncidentPlanBinding } from './incidentPlanBindings'
import type { BoardDoc, Drawing, Entity } from '../types'
import type { Saved } from './workspace'

type Id = string
interface HasId {
  id: Id
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hasId = (v: unknown): v is HasId => isObj(v) && typeof v.id === 'string'
/** An id-keyed collection as the merge can walk it: anything else (a `{}`, a string, a null)
 *  reads as empty. `base`/`theirs` come off the server and the cached ancestor, neither of
 *  which this app alone writes (capture posts, admin edits, other versions), and one `.map` on
 *  a non-array here used to escape as an unhandled rejection that re-threw on every retry. */
const asList = (v: unknown): HasId[] => (Array.isArray(v) ? v.filter(hasId) : [])
/** A key→value record as mergeRecord can walk it; a non-object reads as empty. */
const asRecord = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {})
/** A board (planId → annotations) with every doc coerced to a list. */
const asBoard = (v: unknown): Record<string, HasId[]> =>
  Object.fromEntries(Object.entries(asRecord(v)).map(([k, docs]) => [k, asList(docs)]))

/** Structural equality for plain JSON data (the only thing the blob holds). Used to tell "I
 *  changed this field" from "I left it as the ancestor" in the three-way field/record merges.
 *  Key order is stable here because every value is produced by the same buildPayload code. */
const eq = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Three-way merge of ONE non-collection value: if the resolver (mine) left it at the common
 *  ancestor it yields to the server's value (so the other device's concurrent change survives);
 *  if the resolver changed it, mine wins (last-writer-wins). This is what stops a save in one
 *  domain from reverting a singleton (settings/building/…) edited concurrently in another. */
function pick3<T>(base: T, mine: T, theirs: T): T {
  return eq(mine, base) ? theirs : mine
}

/**
 * Merge one id-keyed collection three ways. `mine` is the local (later) writer, so on a
 * same-id divergence it wins. If only one side changed an object, that change survives. An
 * object present in `base` but dropped on a side is a delete, and a
 * delete beats the other side's edit. Output order is server (theirs) order first, then my
 * new additions — deterministic, so every device converges on the same array after merging.
 *
 * `resolveBoth` (optional) replaces the whole-object LWW for the one case where BOTH sides
 * changed the same object to different values — used by the Trupp merge to go field-level
 * instead of dropping one device's safety record wholesale. It runs only with a real ancestor
 * (a concurrent same-id ADD stays LWW-mine: there is no base to diff against).
 */
export function mergeById<T extends HasId>(
  base: T[],
  mine: T[],
  theirs: T[],
  resolveBoth?: (ancestor: T, mine: T, theirs: T) => T,
): T[] {
  const baseIds = new Set(base.map((o) => o.id))
  const baseMap = new Map(base.map((o) => [o.id, o]))
  const mineMap = new Map(mine.map((o) => [o.id, o]))
  const theirsMap = new Map(theirs.map((o) => [o.id, o]))

  // What survives for a given id, or null if it should be dropped (a delete won).
  const survives = (id: Id): T | null => {
    const inMine = mineMap.has(id)
    const inTheirs = theirsMap.has(id)
    if (inMine && inTheirs) {
      const mine = mineMap.get(id)!, theirs = theirsMap.get(id)!, ancestor = baseMap.get(id)
      if (!ancestor) return mine // concurrent same-id add → last-writer-wins (mine)
      if (eq(mine, ancestor)) return theirs // only the server changed it
      if (eq(theirs, ancestor)) return mine // only I changed it
      if (eq(mine, theirs)) return mine // both made the identical change — nothing to resolve
      return resolveBoth ? resolveBoth(ancestor, mine, theirs) : mine // both changed it → resolver, else LWW-mine
    }
    if (inMine) return baseIds.has(id) ? null : mineMap.get(id)! // theirs deleted → drop; else my add
    if (inTheirs) return baseIds.has(id) ? null : theirsMap.get(id)! // I deleted → drop; else their add
    return null
  }

  const out: T[] = []
  const taken = new Set<Id>()
  for (const o of theirs) {
    const r = survives(o.id)
    if (r && !taken.has(o.id)) { out.push(r); taken.add(o.id) }
  }
  for (const o of mine) {
    if (taken.has(o.id)) continue
    const r = survives(o.id)
    if (r) { out.push(r); taken.add(o.id) }
  }
  return out
}

/** A true same-key divergence in a merged record: BOTH sides changed the key relative to the
 *  ancestor, to different values — the merge stays last-writer-wins (mine), but callers can
 *  surface it (e.g. the attendance conflict note in the Verlauf) instead of staying silent. */
export interface RecordConflict {
  key: string
  mine: unknown
  theirs: unknown
}

/** Three-way merge of a plain key→value record (vehicleOverrides by entity id, checklists by
 *  template id, attendance by Person id, planScale by plan id, and the flat settings/reportMeta
 *  singletons). Per key: a delete (present in base, gone on one side) wins; otherwise the side
 *  that actually CHANGED the value relative to the ancestor wins, and if both changed it's
 *  last-writer-wins (mine). Crucially, a key the resolver left untouched takes the server's value
 *  — so a value another device changed in a different domain is not silently reverted.
 *  `onConflict` (optional) fires for every key BOTH sides changed to different values — the
 *  LWW result is unchanged, the divergence is merely reported. */
export function mergeRecord<V>(
  base: Record<string, V>,
  mine: Record<string, V>,
  theirs: Record<string, V>,
  onConflict?: (c: RecordConflict) => void,
): Record<string, V> {
  const out: Record<string, V> = {}
  base = base ?? {}
  mine = mine ?? {}
  theirs = theirs ?? {}
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const inBase = k in base, inMine = k in mine, inTheirs = k in theirs
    if (inBase && (!inMine || !inTheirs)) continue // a shared key removed on either side → delete wins
    if (!inMine && !inTheirs) continue // never existed / removed on both
    if (inMine && (!inBase || !eq(mine[k], base[k]))) {
      // I added/changed it → mine wins. If THEIRS also moved off the ancestor to something
      // different, that's a genuine both-sides divergence — report it (LWW stays).
      if (onConflict && inTheirs && !eq(mine[k], theirs[k]) && (!inBase || !eq(theirs[k], base[k]))) {
        onConflict({ key: k, mine: mine[k], theirs: theirs[k] })
      }
      out[k] = mine[k]
    }
    else if (inTheirs) out[k] = theirs[k] // I left it at the ancestor → take theirs (their change or unchanged)
    else out[k] = mine[k]
  }
  return out
}

// --- Trupp merge: field-level three-way, because whole-object LWW loses safety data --------
//
// Trupps are SCBA crew monitoring. The everyday concurrent case — the Truppüberwacher books a
// Druckmeldung on the tablet while the EL's phone books the Funkkontakt — used to be resolved
// object-wide LWW, so the later writer's whole Trupp replaced the other device's: a pressure
// reading from the board silently vanished from the legal record. Merged per field, both edits
// survive; the divergence is still REPORTED (onTruppConflict → Verlauf note) so a human checks.

/** Minimal structural view of a Trupp reading row (types.TruppReading). */
interface Readingish {
  t: string
  bar: number
  kind: string
}

/** Trupp fields that are ISO timestamps where "later" is the only safe answer when both sides
 *  wrote one: a contact clock that moves BACKWARDS would re-arm an überfällig alarm somebody
 *  already answered — or worse, silence one by resurrecting a fresher-looking stale time. */
const TRUPP_TIME_FIELDS = new Set(['entryTime', 'lastContactTime', 'lastPressureTime', 'exitTime', 'removedAt'])

/** The later of two ISO timestamps, or null when either doesn't parse (caller falls back). */
function laterIso(a: unknown, b: unknown): unknown | null {
  const ta = Date.parse(String(a)), tb = Date.parse(String(b))
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return ta >= tb ? a : b
}

/**
 * Three-way merge of one Trupp's `readings` log, keyed by (t, kind). The log is append-only in
 * normal operation — the union keeps every row either device wrote — but two writers can still
 * touch the SAME row: an Undo removes the just-appended row (delete wins, like everywhere
 * else), and the entry-pressure correction (useTruppActions) edits a row's `bar` in place (the
 * side that changed it wins; both-changed stays LWW-mine). Output is chronological, so every
 * device converges on the same printed Journal.
 */
function mergeReadings(base: Readingish[], mine: Readingish[], theirs: Readingish[]): Readingish[] {
  const key = (r: Readingish) => `${r.t}|${r.kind}`
  const bm = new Map(base.map((r) => [key(r), r]))
  const mm = new Map(mine.map((r) => [key(r), r]))
  const tm = new Map(theirs.map((r) => [key(r), r]))
  const out: Readingish[] = []
  for (const k of new Set([...tm.keys(), ...mm.keys()])) {
    const inM = mm.has(k), inT = tm.has(k), inB = bm.has(k)
    if (inM && inT) {
      const b = bm.get(k), m = mm.get(k)!, t = tm.get(k)!
      out.push(!b || !eq(m, b) ? m : t) // a one-sided bar correction wins; both-changed → mine
    } else if ((inM || inT) && !inB) {
      out.push((mm.get(k) ?? tm.get(k))!) // a new row from either side — never dropped
    } // in base but gone on one side → that side's Undo removed it → stays gone
  }
  out.sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0)) // stable → same-t keeps insertion order
  return out
}

/**
 * Field-level three-way merge of ONE Trupp both sides changed (mergeById's `resolveBoth` for
 * the trupps collection). Per field, mergeRecord semantics: the side that changed it wins, a
 * removed shared field stays removed (an Undo clearing e.g. `removedAt`). Where BOTH sides
 * changed the same field:
 *   - timestamps (TRUPP_TIME_FIELDS) take the LATER value — a contact clock never moves back;
 *   - `lastPressureBar` rides with `lastPressureTime` (a bar from one reading stamped with the
 *     other reading's time would assert a pressure at a moment it wasn't read);
 *   - `lowestBar` joins at the MIN — it is monotone-min within a run, so the union of what two
 *     devices saw is the lower one, and a low reading is never lost;
 *   - `readings` is the keyed union above;
 *   - `status` + `entryTime` + `exitTime` resolve as ONE unit when both sides moved the status
 *     (see below — a chimera of one side's status with the other's stamps can silence the
 *     contact clock for a crew that is inside);
 *   - everything else keeps the collection-wide LWW-mine precedence.
 */
function mergeTrupp(ancestor: HasId, mine: HasId, theirs: HasId): HasId {
  const a = ancestor as unknown as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(m), ...Object.keys(t)])) {
    if (k === 'readings') continue // merged below
    const inA = k in a, inM = k in m, inT = k in t
    if (inA && (!inM || !inT)) continue // a shared field removed on either side → delete wins
    if (!inM) { out[k] = t[k]; continue } // their new field
    if (!inT) { out[k] = m[k]; continue } // my new field
    if (eq(m[k], t[k])) { out[k] = m[k]; continue } // same value — nothing to resolve
    if (eq(m[k], a[k])) { out[k] = t[k]; continue } // only theirs changed it
    if (eq(t[k], a[k])) { out[k] = m[k]; continue } // only I changed it
    // both changed it, to different values:
    if (TRUPP_TIME_FIELDS.has(k)) out[k] = laterIso(m[k], t[k]) ?? m[k]
    else if (k === 'lowestBar' && typeof m[k] === 'number' && typeof t[k] === 'number') {
      out[k] = Math.min(m[k] as number, t[k] as number)
    } else out[k] = m[k] // scalar divergence stays LWW-mine (conservative)
  }
  // lastPressureBar follows the reading that won lastPressureTime when both sides logged one —
  // the generic loop resolves the two fields independently and could pair A's bar with B's time.
  const bothLoggedPressure =
    !eq(m.lastPressureTime, a.lastPressureTime) && !eq(t.lastPressureTime, a.lastPressureTime) &&
    !eq(m.lastPressureTime, t.lastPressureTime)
  if (bothLoggedPressure) {
    const winner = eq(out.lastPressureTime, m.lastPressureTime) ? m : t
    if ('lastPressureBar' in winner) out.lastPressureBar = winner.lastPressureBar
  }
  // The state machine is ONE fact, not three fields. When both sides moved `status` to
  // different values, the generic loop pairs one side's status with the other side's stamps —
  // a tablet's «Eingerückt» racing a phone's «Draussen» converged on {status:'aktiv', exitTime},
  // which deriveTruppLive reads as raus: contact clock and überfällig alarm silently OFF for a
  // crew that was just sent in. Resolve {status, entryTime, exitTime} from ONE side instead:
  // the in-field side when exactly one is in the field (the louder state wins — the same
  // doctrine that lets überfällig beat a manual Rückzug; false «drinnen» keeps the monitoring
  // alive, false «raus» kills it), else mine.
  const statusConflict = 'status' in m && 'status' in t &&
    !eq(m.status, t.status) && !eq(m.status, a.status) && !eq(t.status, a.status)
  if (statusConflict) {
    const inField = (s: unknown) => s !== 'angemeldet' && s !== 'raus' // mirrors deriveTruppLive
    const winner = inField(m.status) ? m : inField(t.status) ? t : m
    for (const k of ['status', 'entryTime', 'exitTime']) {
      if (k in winner) out[k] = winner[k]
      else delete out[k]
    }
  }
  if ('readings' in m || 'readings' in t) {
    const rows = (v: unknown): Readingish[] => (Array.isArray(v) ? (v.filter(isObj) as unknown as Readingish[]) : [])
    out.readings = mergeReadings(rows(a.readings), rows(m.readings), rows(t.readings))
  }
  return out as unknown as HasId
}

/**
 * `reportMeta`, with the three NESTED collections merged per entry instead of as opaque values.
 *
 * ⚠️ `linksDone` (the station's Rapport-Formulare, ticked off per Einsatz) is a
 * `Record<linkId, ISO>`, and the flat merge treats a whole object as one value: the AdFU
 * ticking «Getränke» on the tablet while the EL ticks «Schadenmeldung» on the phone would end
 * with one of the two ticks gone, silently — while the field's own doc comment promises that
 * whoever opens the Rapport next sees what is already away. Merged per link id it is a union,
 * and an untick still beats a concurrent tick (delete wins, as everywhere else here).
 *
 * ⚠️ `gruppen` / `fahrzeuge` (the Alarmierungs-/Ausrückzeiten grid) are id-keyed ARRAYS with a
 * writer this app does not control: the alarm pipeline pushes per-vehicle Ausrück-/Vor-Ort-/
 * Zurück-Zeiten straight into the server's blob (backend api/alarms · apply_milestones). Merged
 * flat, the array is one value — so the moment the operator typed a single time into the grid,
 * `fahrzeuge` differed from the ancestor, «mine wins» took the whole array, and every row the
 * webhook had written was gone. That is exactly the report from 31.08.: the Verlauf carried
 * «PIO vor Ort 20:14» (the webhook only logs a row when it WRITES the value) while the grid
 * stayed empty. Merged by id, a machine-written row and a hand-typed one survive each other,
 * and `manual` keeps meaning what it means on the server: human beats machine, per row.
 *
 * Every other reportMeta field is a scalar or a small value object edited as a unit, so the
 * flat merge is right for them and stays.
 */
function mergeReportMeta(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> {
  const out = mergeRecord(base, mine, theirs)
  const done = mergeRecord(asRecord(base.linksDone), asRecord(mine.linksDone), asRecord(theirs.linksDone))
  if (Object.keys(done).length) out.linksDone = done
  else delete out.linksDone
  for (const k of ['gruppen', 'fahrzeuge'] as const) {
    const rows = mergeById(asList(base[k]), asList(mine[k]), asList(theirs[k]))
    if (rows.length) out[k] = rows
    else delete out[k]
  }
  return out
}

// --- Suche: records by id, and each record's `log` as a keyed union ----------------------------
//
// A Person or Bereich (types · SucheDoc) is a small record plus its append-only `log` — the one
// list every state of the Suche is folded from (lib/suche). Whole-object LWW would lose a row: the
// FU booking «Tim Muster gefunden» on the tablet while the phone books «übergeben an
// Rettungsdienst» on the same person is exactly the concurrent case this slice exists for. So a
// record both sides changed merges like a Trupp does — the plain fields three-way (the side that
// changed one wins, both-changed stays LWW-mine), and the `log` as a union keyed by row id: a new
// row from either side survives, a row in the ancestor that one side no longer has was taken back
// by that side's ↶ and stays gone (delete wins, as everywhere in this file).

interface Rowish { id: string; at?: string }

function mergeLog(base: Rowish[], mine: Rowish[], theirs: Rowish[]): Rowish[] {
  const b = new Set(base.map((r) => r.id))
  const m = new Map(mine.map((r) => [r.id, r]))
  const t = new Map(theirs.map((r) => [r.id, r]))
  const out: Rowish[] = []
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    if (m.has(id) && t.has(id)) out.push(m.get(id)!) // rows are immutable — either copy is the row
    else if (!b.has(id)) out.push((m.get(id) ?? t.get(id))!) // a new row from one side
    // in base but gone on one side → that side's ↶ removed it → stays gone
  }
  // chronological, stable for equal instants — every device converges on the same order
  return out.map((r, i) => ({ r, i }))
    .sort((x, y) => String(x.r.at ?? '').localeCompare(String(y.r.at ?? '')) || x.i - y.i)
    .map((x) => x.r)
}

function mergeWithLog(ancestor: HasId, mine: HasId, theirs: HasId): HasId {
  const a = ancestor as unknown as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  const fields = mergeRecord(
    Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'log')),
    Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'log')),
    Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'log')),
  )
  const rows = (v: unknown): Rowish[] => (Array.isArray(v) ? v.filter(hasId) as Rowish[] : [])
  return { ...fields, id: mine.id, log: mergeLog(rows(a.log), rows(m.log), rows(t.log)) } as unknown as HasId
}

/** The `suche` slice: `personen` and `bereiche` each by id, with the log union above for a
 *  record both sides wrote. A slice absent on every side stays absent (an incident that never
 *  opened the Suche carries no key). */
export function mergeSuche(b: unknown, m: unknown, t: unknown): unknown {
  if (b == null && m == null && t == null) return undefined
  const list = (v: unknown, k: 'personen' | 'bereiche') => asList(asRecord(v)[k])
  const merge = (k: 'personen' | 'bereiche') => {
    const base = list(b, k), mine = list(m, k), theirs = list(t, k)
    // ⚠️ A record BOTH sides added under one id has no ancestor — and mergeById then keeps mine
    // whole (a concurrent same-id add is LWW). For the Suche that is the ordinary case, not a
    // collision: a storey's area has a DERIVED id (`sbg:<stack>:<n>`), both devices seed it, and
    // both write rows onto it — so the other device's rows would be gone. Give such a record an
    // EMPTY ancestor, and it merges field-wise with its log unioned like any other.
    const inBase = new Set(base.map((x) => x.id))
    const theirIds = new Set(theirs.map((x) => x.id))
    const both = mine.filter((x) => !inBase.has(x.id) && theirIds.has(x.id)).map((x) => ({ id: x.id, log: [] }) as HasId)
    return mergeById([...base, ...both], mine, theirs, mergeWithLog)
  }
  return { personen: merge('personen'), bereiche: merge('bereiche') }
}

// (per-plan board merging is gone — since schema 2 the board is a derived view of the merged
// `objects` collection, so a plan's annos merge as whole objects like everything else)

// --- The merge policy: one row per field of the blob -----------------------------------------
//
// ⚠️ Every field of `Saved` states HOW it merges, and the map is checked against `Saved` at
// compile time (`satisfies Record<keyof Saved, FieldPolicy>`): a field added to the blob without
// a row here fails `tsc`. The old shape — a `...mine` spread with the merged fields listed after
// it — let a new synced field fall through to «this device wins» silently, which is how
// `attendance`, `settings`, `reportMeta` and `intakeReviewedAt` each clobbered concurrent edits
// until they were given a merge of their own. Policy map since 23.09.2026.

/** What a field's merge may need beyond its own three values: the tactical objects (merged ONCE,
 *  up front, because the three legacy views are derived from them) and the two conflict reporters. */
interface MergeCx {
  objects: TacticalObject[]
  views: ObjectViews
  onAttendanceConflict?: (c: RecordConflict) => void
  onTruppConflict?: (c: RecordConflict) => void
}

/** How ONE field of the blob merges.
 *  - `'local'` — genuinely local view/device state: the resolving device's own value, verbatim
 *    (absent stays absent). A merge must never yank the resolving device's active plan or its
 *    layer toggles.
 *  - a function — the three-way merge of that field (base, mine, theirs, each exactly as it
 *    stands in its blob, so possibly malformed or absent); its result is always written. */
type FieldPolicy = 'local' | ((b: unknown, m: unknown, t: unknown, cx: MergeCx) => unknown)

const byId = (b: unknown, m: unknown, t: unknown) => mergeById(asList(b), asList(m), asList(t))
const byKey = (b: unknown, m: unknown, t: unknown) => mergeRecord(asRecord(b), asRecord(m), asRecord(t))

/** Every field of the blob and how it merges (see FieldPolicy). The functions run in this order,
 *  which is also the order their keys are appended to the merged blob. */
export const MERGE_POLICY = {
  // the unified tactical objects (schema 2) — authoritative; merged up front (mergeWorkspace)
  objects: (_b, _m, _t, cx) => cx.objects,
  // … and the three legacy collections, its DERIVED views (see lib/workspace · Saved.objects)
  entities: (_b, _m, _t, cx) => cx.views.entities,
  drawings: (_b, _m, _t, cx) => cx.views.drawings,
  timeline: byId,
  // field-level, not whole-object LWW: see mergeTrupp for why trupps are the exception
  trupps: (b, m, t, cx) => mergeById(asList(b), asList(m), asList(t), (ancestor, mi, th) => {
    cx.onTruppConflict?.({ key: mi.id, mine: mi, theirs: th })
    return mergeTrupp(ancestor, mi, th)
  }),
  mittel: byId, // append-only material-use events — merge by event id like timeline
  shifts: byId, // Schichtenplanung: planned availability blocks, merged by shift id
  // the Schichten grid's columns. They merge by id like any other collection, which gives exactly
  // the semantics the surface needs for free: a band the AdFU creates at the desk appears on the
  // EL's phone seconds later, two devices each creating one keep both, and a delete beats a
  // concurrent rename. Creating a band writes NO shifts (see types.ShiftBand), so the one
  // resolution this merge can never be asked for is 66 duplicated shifts per device.
  bands: byId,
  cameraViews: byId,
  // Ghost «Spuren» (lib/truppTrails) — the searched area a removed Trupp marker left behind.
  // Merges by id like any collection, and it converges without a resolver because the id is
  // DERIVED from the marker (`ght-<markerId>`): two devices reconciling the same removal write
  // the same row rather than two copies of one walked line, and «Spur löschen» is a `removedAt`
  // stamp (a field edit) rather than a drop, so a delete cannot race a concurrent reconciliation.
  trails: byId,
  // Rapport-Beilagen (document/damage photos) — merge by id like any other collection: two
  // devices each adding one keeps both, and a delete beats a concurrent caption edit.
  attachments: byId,
  // the Suche (Personen + Bereiche): records by id, each record's append-only log as a union —
  // see mergeSuche above
  suche: mergeSuche,
  board: (_b, _m, _t, cx) => cx.views.board,
  vehicleOverrides: byKey, // by entity id
  checklists: byKey, // by template id
  // records/singletons that ALSO need three-way merging so a concurrent edit in another domain
  // (the "task-scoped multi-editor" case) isn't clobbered by the resolver's whole blob:
  attendance: (b, m, t, cx) => mergeRecord(asRecord(b), asRecord(m), asRecord(t), cx.onAttendanceConflict), // per-Person presence — a prime parallel-editor surface
  planScale: byKey, // per-plan calibration (planId → scale)
  settings: byKey, // per-incident operational settings (Atemschutz doctrine …)
  reportMeta: (b, m, t) => mergeReportMeta(asRecord(b), asRecord(m), asRecord(t)), // Einsatzrapport bookkeeping text
  // frozen sheet bindings — NOT mergeById: the first server binding fixes the backdrop, and only
  // an override of that same snapshot merges; the rule lives with the binding type
  // (lib/incidentPlanBindings).
  planBindings: (b, m, t) => mergeIncidentPlanBindings(
    asList(b) as IncidentPlanBinding[],
    asList(m) as IncidentPlanBinding[],
    asList(t) as IncidentPlanBinding[],
  ),
  building: pick3, // the Gebäude floor-stack doc (merged whole — same-object stays LWW)
  pickedObjectId: pick3, // the shared picked Einsatzobjekt (one picture across devices)
  // «Einsatzdaten geprüft» stamp — MUST be merged, not left to mine: a device that still shows
  // the review banner saves without it, and «mine» would quietly unset the stamp another device
  // just wrote, bringing the banner back on every device.
  intakeReviewedAt: pick3,
  // genuinely local view/device state:
  activePlanId: 'local',
  activeModule: 'local',
  layerState: 'local',
  recent: 'local',
  // written only by the replay fold, never by a live save — nothing to merge
  weather: 'local',
  // the resolving build's own stamp: the merged blob is what THIS build wrote
  schemaVersion: 'local',
} satisfies Record<keyof Saved, FieldPolicy>

/** The top-level keys of a blob that no MERGE_POLICY row names — a slice a newer build added.
 *  The one place that says which keys this build does not know (sanitize, save, merge ask it). */
export function unknownWorkspaceKeys(blob: Record<string, unknown>): string[] {
  return Object.keys(blob).filter((k) => !(k in MERGE_POLICY))
}

/**
 * Three-way merge of whole workspace blobs, built for TASK-SCOPED multi-editor use: two operators
 * working DIFFERENT domains of one incident (e.g. Atemschutz on one device, Lage/Plan/report on
 * another) must both keep their work. Every operational domain is merged so a save in one domain
 * never clobbers a concurrent edit in another:
 *   - object collections (entities, drawings, timeline, trupps, cameraViews, trails, board) → per-object
 *     three-way by id (independent adds survive, same object is LWW-mine, delete beats edit);
 *   - records (vehicleOverrides, checklists, attendance, planScale) and singletons (settings,
 *     reportMeta, building, pickedObjectId) → three-way by value, so a field the resolver didn't
 *     touch yields to the server's concurrent change instead of being reverted.
 * Only genuinely LOCAL view/device state stays mine (the `'local'` rows of MERGE_POLICY:
 * activePlanId, activeModule, layerState, recent, weather, schemaVersion). A key this build does
 * not know at all rides with mine too, as it always has.
 * (Same-object field-level edits remain LWW-mine for every collection except trupps — see the
 * documented limitation in the tests, and mergeTrupp for why trupps are the exception.)
 *
 * `onAttendanceConflict` (optional) reports every attendance key BOTH sides changed to different
 * values (same person, divergent entries — e.g. QR capture vs. KP tablet). The merge result is
 * unchanged (LWW); the caller appends a Verlauf note so the divergence is reviewable.
 *
 * `onTruppConflict` (optional) reports every Trupp BOTH sides changed concurrently. Unlike
 * attendance, the merge here is field-level (mergeTrupp) so nothing is silently dropped — but
 * two devices writing the same SCBA crew's record at once is still worth a human look, so the
 * caller appends a Verlauf note the same way. `key` = the Trupp id, mine/theirs = both objects.
 *
 * `base` and `theirs` are coerced first (asList / asRecord): `mine` is this app's own
 * buildPayload and clean, the other two are whatever the server and the cached ancestor hold.
 * A collection that is not an array merges as empty rather than throwing — the throw used to
 * wedge sync silently and forever (badge stuck on «ausstehend», no toast, re-thrown every retry).
 */
export function mergeWorkspace(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  onAttendanceConflict?: (c: RecordConflict) => void,
  onTruppConflict?: (c: RecordConflict) => void,
): Record<string, unknown> {
  // The unified objects (schema 2) are the authoritative tactical collection: each side
  // unifies FIRST (a legacy side — an un-updated device's save — derives its objects from
  // its views), the objects merge per id like any collection, and the three legacy views
  // are then DERIVED from the merged result. Merging views independently beside the
  // objects could let the two disagree about the same id — one truth, derived twice.
  const objectsOf = (ws: Record<string, unknown>): TacticalObject[] =>
    Array.isArray(ws.objects)
      ? (ws.objects as TacticalObject[])
      : objectsFromLegacy(
          asList(ws.entities) as Entity[],
          asList(ws.drawings) as Drawing[],
          asBoard(ws.board) as BoardDoc,
        )
  const objects = mergeById(objectsOf(base), objectsOf(mine), objectsOf(theirs))
  const cx: MergeCx = { objects, views: viewsOf(objects), onAttendanceConflict, onTruppConflict }
  const out: Record<string, unknown> = { ...mine } // the 'local' rows
  for (const [k, policy] of Object.entries(MERGE_POLICY) as [keyof Saved, FieldPolicy][]) {
    if (policy !== 'local') out[k] = policy(base[k], mine[k], theirs[k], cx)
  }
  // …and a key this build does not know — a slice a NEWER build added. It is carried through
  // untouched (lib/workspace · sanitizeWorkspace keeps it, the save echoes it back), so here it
  // merges three-way as a value; and where this device's blob lacks it altogether, that is «never
  // knew it», never «deleted it»: the other side's value stands. Without this an older device's
  // save erased a whole new slice (the Suche, 24.09.2026).
  for (const k of unknownWorkspaceKeys({ ...base, ...theirs, ...mine })) {
    if (k in mine) out[k] = pick3(base[k], mine[k], theirs[k])
    else if (k in theirs) out[k] = theirs[k]
  }
  return out
}
