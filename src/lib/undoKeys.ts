import type { Saved } from './workspace'
import { GEBAEUDE_PLAN_ID } from './whiteboard'
import type { UndoEntry, UndoTimeline } from './undoTimeline'

/**
 * WHICH RECORDS an undo step writes, and which ones a remote merge changed — the two halves of
 * «does this ↶ still describe something real» (25.09.2026).
 *
 * Until then a remote hydrate dropped the whole timeline, on the reasoning that nothing on it
 * described anything real any more (08.09.2026). With three devices on an Einsatz a remote save
 * lands every few seconds, so ↶ was grey almost all of the time — and a one-tap mistake was
 * unrecoverable, which is the one thing the 3am tenet forbids outright. The rule is now narrower
 * and exact: a merge drops the steps whose inverse would write a record the merge CHANGED (and,
 * transitively, the older steps that would write a record one of those dropped steps wrote), and
 * keeps every other step, re-laid onto the merged state.
 *
 * ⚠️ A record here is the unit the MERGE works at (`mergeWorkspace · MERGE_POLICY`), never finer:
 * a Trupp is one record even though its fields merge one by one, a Rapport field is one record,
 * an Anwesenheit is one person. Coarser than the merge is always safe (a step is dropped that
 * could have stayed); finer would let a ↶ write half of a record the merge had just assembled.
 */

/** `<field>:<id>` — one record of the synced workspace: an object/Trupp/Mittel row by its `id`, an
 *  Anwesenheit by person, a Rapport field by name, a singleton (the Gebäude) as `<field>:`.
 *  `<field>:*` stands for every record of the field. Two derived fields exist only here:
 *  `planview:<planId>` — «what that sheet SHOWS changed» (a plan's history snapshots the sheet's
 *  view, projections included), see `planViewChanges`. */
export type RecordKey = string

export const recordKey = (field: string, id = ''): RecordKey => `${field}:${id}`

function splitKey(k: RecordKey): [string, string] {
  const i = k.indexOf(':')
  return i < 0 ? [k, ''] : [k.slice(0, i), k.slice(i + 1)]
}

/** A growing set of keys that answers «does any of THESE meet one of mine», wildcards included. */
export interface KeyMatcher {
  readonly empty: boolean
  meets: (keys: readonly RecordKey[]) => boolean
  add: (keys: Iterable<RecordKey>) => void
}

export function keyMatcher(initial: Iterable<RecordKey> = []): KeyMatcher {
  const exact = new Set<RecordKey>()
  const fields = new Set<string>() // fields with at least one exact key
  const whole = new Set<string>() // fields named with `*`
  const add = (keys: Iterable<RecordKey>) => {
    for (const k of keys) {
      const [f, id] = splitKey(k)
      if (id === '*') whole.add(f)
      else { exact.add(k); fields.add(f) }
    }
  }
  add(initial)
  return {
    get empty() { return exact.size === 0 && whole.size === 0 },
    meets: (keys) => keys.some((k) => {
      const [f, id] = splitKey(k)
      if (whole.has(f)) return true
      return id === '*' ? fields.has(f) : exact.has(k)
    }),
    add,
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Equal as the WIRE sees it: key order does not matter and an `undefined` property is the same
 * as an absent one (JSON drops both). A record that went out and came back through a merge is a
 * fresh object with its keys in whatever order the server kept them, and reading that as «the
 * merge changed it» would drop every step on every hydrate.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false
    return true
  }
  if (!isPlain(a) || !isPlain(b)) return false
  let n = 0
  for (const k in a) {
    if (a[k] === undefined) continue
    n++
    if (!sameValue(a[k], b[k])) return false
  }
  for (const k in b) if (b[k] !== undefined) n--
  return n === 0
}

/**
 * How a value is made of records — the one thing both the merge diff and a history's re-laying
 * need to know about a slice.
 */
export interface RecordShape<T> {
  /** every record of `v`, under its key (an absent record simply has no entry) */
  records: (v: T) => Map<RecordKey, unknown>
  /** `v` with the named records set to the values given (`undefined` = absent), everything else
   *  exactly as it was — the same object when nothing had to change. A record that comes BACK
   *  takes its place from `order`, the state its value was read from. */
  patch: (v: T, values: ReadonlyMap<RecordKey, unknown>, order: T) => T
  /**
   * The OTHER records one record's value depends on — a placard docked to its host, a Leitung
   * end attached to an object or another line. A step that writes such a record re-states the
   * link, and the link means «where the target is NOW»: a ↷ re-docking a placard onto a host
   * another device has since moved a kilometre would drop it at the old spot. So a step also
   * touches every record its written values point at, old value and new (`stepTouches`).
   */
  refs?: (value: unknown) => RecordKey[]
}

interface HasId { id: string }
const hasId = (v: unknown): v is HasId => isPlain(v) && typeof v.id === 'string'

/** An id-keyed list (objects, Trupps, Mittel, Schichten, …) — `mergeById`'s unit. */
export function listById<E extends HasId>(field: string, refs?: (value: unknown) => RecordKey[]): RecordShape<E[]> {
  const key = (id: string) => recordKey(field, id)
  return {
    refs,
    records: (v) => new Map((Array.isArray(v) ? v : []).filter(hasId).map((o) => [key(o.id), o])),
    patch: (v, values, order) => {
      const list = Array.isArray(v) ? v : []
      let changed = false
      const out: E[] = []
      const standing = new Set<string>()
      for (const o of list) {
        const k = key(o.id)
        if (!values.has(k)) { out.push(o); standing.add(o.id); continue }
        const next = values.get(k) as E | undefined
        if (next !== o) changed = true
        if (next !== undefined) { out.push(next); standing.add(o.id) }
      }
      // …and the ones that come back, each after the nearest of its predecessors in `order` that
      // still stands (or first, when none does) — so a restored row lands where it stood
      const orderIds = (Array.isArray(order) ? order : []).map((o) => o.id)
      const back = [...values.values()]
        .filter((val): val is E => hasId(val) && !standing.has(val.id))
        .sort((a, b) => orderIds.indexOf(a.id) - orderIds.indexOf(b.id))
      for (const val of back) {
        const at = orderIds.indexOf(val.id)
        let pos = at < 0 ? out.length : 0
        for (let i = at - 1; i >= 0; i--) {
          const j = out.findIndex((o) => o.id === orderIds[i])
          if (j >= 0) { pos = j + 1; break }
        }
        out.splice(pos, 0, val)
        standing.add(val.id)
        changed = true
      }
      return changed ? out : list
    },
  }
}

/** A key→value record (Anwesenheit by person, Checklisten by template, the Rapport by field) —
 *  `mergeRecord`'s unit. `ignore` names keys that are not records of their own here: they are
 *  neither reported nor written (the Rapport's machine bookkeeping, lib/reportUndo). */
export function recordByKey<V>(field: string, ignore: readonly string[] = []): RecordShape<Record<string, V>> {
  const skip = new Set(ignore)
  return {
    records: (v) => new Map(Object.entries(isPlain(v) ? v : {})
      .filter(([k, val]) => val !== undefined && !skip.has(k))
      .map(([k, val]) => [recordKey(field, k), val])),
    patch: (v, values) => {
      const base = isPlain(v) ? v : {}
      let out: Record<string, V> | null = null
      for (const [k, val] of values) {
        const [f, id] = splitKey(k)
        if (f !== field || skip.has(id)) continue
        if (base[id] === val) continue
        out ??= { ...base }
        if (val === undefined) delete out[id]
        else out[id] = val as V
      }
      return out ?? base
    },
  }
}

/** One value that merges whole (the Gebäude, the picked Einsatzobjekt) — `pick3`'s unit. */
export function singleton<T>(field: string): RecordShape<T> {
  const k = recordKey(field)
  return {
    records: (v) => new Map(v === undefined || v === null ? [] : [[k, v]]),
    patch: (v, values) => (values.has(k) ? (values.get(k) ?? null) as T : v),
  }
}

/** Several shapes side by side under one object — the Zeitplan's `{ shifts, bands }`, which is
 *  one slice to the operator and two collections to the merge. Each property's shape must use the
 *  property's own name as its field. */
export function fieldsOf<T extends Record<string, unknown>>(shapes: { [K in keyof T]: RecordShape<T[K]> }): RecordShape<T> {
  const names = Object.keys(shapes) as (keyof T & string)[]
  return {
    records: (v) => {
      const out = new Map<RecordKey, unknown>()
      for (const n of names) for (const [k, val] of shapes[n].records((isPlain(v) ? v[n] : undefined) as T[typeof n])) out.set(k, val)
      return out
    },
    patch: (v, values, order) => {
      let out: T | null = null
      for (const n of names) {
        const mine = new Map([...values].filter(([k]) => splitKey(k)[0] === n))
        if (!mine.size) continue
        const base: T = out ?? v
        const cur: T[typeof n] = base[n]
        const next = shapes[n].patch(cur, mine, order[n])
        if (next !== cur) out = { ...base, [n]: next }
      }
      return out ?? v
    },
  }
}

/**
 * Every record a tactical object's value POINTS AT (RecordShape · refs). Audited 25.09.2026
 * against `types` / `tacticalObjects`: the only id-valued links between records are
 *   • `dockedTo` — a Gefahrentafel on its host (Entity);
 *   • `startAttachment` / `endAttachment` — a Leitung end on an object or on another line
 *     (Drawing and BoardAnno alike, so every body is read);
 *   • `truppId` — a marker, chip or hose that belongs to a Trupp;
 *   • a Gebäude-stack body's `floor` — a storey the `building` has to still have.
 * (`sheet.planId` names a sheet, not a record; its fit is `planview:`'s business.)
 */
export function objectRefs(value: unknown): RecordKey[] {
  if (!isPlain(value)) return []
  const out: RecordKey[] = []
  const sheet = isPlain(value.sheet) ? value.sheet : null
  for (const body of [value.entity, value.drawing, sheet?.anno]) {
    if (!isPlain(body)) continue
    if (typeof body.dockedTo === 'string') out.push(recordKey('objects', body.dockedTo))
    for (const att of [body.startAttachment, body.endAttachment]) {
      if (isPlain(att) && isPlain(att.target) && typeof att.target.id === 'string') out.push(recordKey('objects', att.target.id))
    }
    if (typeof body.truppId === 'string') out.push(recordKey('trupps', body.truppId))
  }
  if (sheet?.planId === GEBAEUDE_PLAN_ID) out.push(recordKey('building'))
  return out
}

/** …and the same links read off a sheet's anno (a plan snapshot holds annos, not objects). */
export const annoRefs = (anno: unknown): RecordKey[] => objectRefs({ drawing: anno })

/** The records whose value differs between `a` and `b`, mapped to their value in `b` (`undefined`
 *  = absent there). `a` → `b` is a step; this is what the step wrote. */
export function recordDiff<T>(a: T, b: T, shape: Pick<RecordShape<T>, 'records'>): Map<RecordKey, unknown> {
  const out = new Map<RecordKey, unknown>()
  if (a === b) return out
  const ra = shape.records(a)
  const rb = shape.records(b)
  for (const [k, va] of ra) {
    const vb = rb.get(k)
    if (va !== vb && !sameValue(va, vb)) out.set(k, vb)
  }
  for (const [k, vb] of rb) if (!ra.has(k)) out.set(k, vb)
  return out
}

/** Trupps by id — WITHOUT the crew filing's one-shot marker (types · Trupp.crewFiled, #227). The
 *  marker is grow-only (merged as a union, never a Trupp conflict) and every Trupp inverse keeps
 *  the live one (crewFiling · keepCrewFiled), so no ↶ can carry an old value back into it. A merge
 *  that only grew it — another device filed the crew a moment later, which is its job — changed
 *  nothing a step writes, and must not cost the steps on that Trupp. Records only: no snapshot
 *  history is re-laid over Trupps (they join the timeline as closures, useTruppActions). */
const truppRecords: Pick<RecordShape<unknown>, 'records'> = {
  records: (v) => {
    const out = new Map<RecordKey, unknown>()
    if (!Array.isArray(v)) return out
    for (const t of v) {
      if (!hasId(t)) continue
      const { crewFiled: _filed, ...rest } = t as HasId & { crewFiled?: unknown }
      out.set(recordKey('trupps', t.id), rest)
    }
    return out
  },
}

/** One record of the Suche (lib/suche): a person or a Bereich, by id — `mergeSuche`'s unit (a
 *  record both devices changed merges field-wise with its log unioned, so the record is the unit
 *  here, never a single row: coarser than the merge is safe). `suche:<kind>/<id>`. */
export const sucheRecordKey = (kind: 'personen' | 'bereiche', id: string): RecordKey => recordKey('suche', `${kind}/${id}`)

const sucheRecords: Pick<RecordShape<unknown>, 'records'> = {
  records: (v) => {
    const out = new Map<RecordKey, unknown>()
    if (!isPlain(v)) return out
    for (const kind of ['personen', 'bereiche'] as const) {
      const list = v[kind]
      if (Array.isArray(list)) for (const r of list) if (hasId(r)) out.set(sucheRecordKey(kind, r.id), r)
    }
    return out
  },
}

// ── the synced workspace, record by record ──────────────────────────────────────────────────────

/** How each field of the blob is made of records — `null` for what no undo step can write and no
 *  merge has to report: the three legacy views of `objects`, the append-only Verlauf echo, and the
 *  device-local fields. Checked against `Saved` at compile time, like MERGE_POLICY: a synced field
 *  added without a row here fails `tsc` rather than being silently invisible to a merge. */
export const WORKSPACE_RECORDS = {
  objects: listById('objects', objectRefs),
  entities: null,
  drawings: null,
  board: null,
  timeline: null,
  trupps: truppRecords,
  mittel: listById('mittel'),
  shifts: listById('shifts'),
  bands: listById('bands'),
  cameraViews: listById('cameraViews'),
  trails: listById('trails'),
  attachments: listById('attachments'),
  suche: sucheRecords,
  vehicleOverrides: recordByKey('vehicleOverrides'),
  checklists: recordByKey('checklists'),
  attendance: recordByKey('attendance'),
  planScale: recordByKey('planScale'),
  settings: recordByKey('settings'),
  reportMeta: recordByKey('reportMeta'),
  planBindings: listById('planBindings'),
  building: singleton('building'),
  pickedObjectId: singleton('pickedObjectId'),
  intakeReviewedAt: singleton('intakeReviewedAt'),
  activePlanId: null,
  activeModule: null,
  layerState: null,
  recent: null,
  weather: null,
  schemaVersion: null,
} satisfies Record<keyof Saved, Pick<RecordShape<never>, 'records'> | null>

/** The fields a merge diff reads — every WORKSPACE_RECORDS row that is not `null`. The render's
 *  copy of them (IncidentWorkspace · liveWs) is typed against this, so a slice added here without
 *  being handed to the diff fails `tsc` instead of reading as «every record changed» on every
 *  hydrate. */
export type RecordedField = { [K in keyof typeof WORKSPACE_RECORDS]: (typeof WORKSPACE_RECORDS)[K] extends null ? never : K }[keyof typeof WORKSPACE_RECORDS]

/**
 * What a step from `before` to `after` TOUCHES: the records it writes, plus every record the old
 * or the new value of one of them points at (RecordShape · refs).
 */
export function stepTouches<T>(before: T, after: T, shape: RecordShape<T>): RecordKey[] {
  const wrote = recordDiff(before, after, shape)
  if (!shape.refs || !wrote.size) return [...wrote.keys()]
  const out = new Set<RecordKey>(wrote.keys())
  const old = shape.records(before)
  for (const [k, v] of wrote) {
    for (const r of shape.refs(old.get(k))) out.add(r)
    for (const r of shape.refs(v)) out.add(r)
  }
  return [...out]
}

/** Every record a hydrate changes: the live state before it against the state it writes. */
export function workspaceChanges(prev: Partial<Record<keyof Saved, unknown>>, next: Partial<Record<keyof Saved, unknown>>): Set<RecordKey> {
  const out = new Set<RecordKey>()
  for (const [field, shape] of Object.entries(WORKSPACE_RECORDS) as [keyof Saved, Pick<RecordShape<unknown>, 'records'> | null][]) {
    if (!shape) continue
    for (const k of recordDiff(prev[field], next[field], shape).keys()) out.add(k)
  }
  return out
}

/** The fields a plan sheet's FIT is derived from. When any of them moved, every sheet's view may
 *  have moved with it, and no plan history's snapshots can be trusted to describe it any more. */
const FIT_FIELDS = ['planScale', 'planBindings', 'building', 'pickedObjectId']

/**
 * `planview:<planId>` for every sheet whose VIEW a merge changed: an object it shows changed (or
 * began or stopped being shown), or a fit moved (`planview:*`).
 *
 * ⚠️ Needed because a plan's history snapshots the sheet as DRAWN, projections of the Karte's
 * objects included, and restores it through `setBoard`, where an absent anno is a deletion. A
 * remote device adding a Fahrzeug that projects onto this sheet does not touch any anno the
 * history ever held — and restoring an older snapshot would still delete it.
 */
export function planViewChanges(
  before: Readonly<Record<string, readonly HasId[]>>,
  /** a thunk: deriving every sheet's view is the costly half, and most merges change no object */
  after: () => Readonly<Record<string, readonly HasId[]>>,
  changed: ReadonlySet<RecordKey>,
): RecordKey[] {
  const ids = new Set<string>()
  for (const k of changed) {
    const [f, id] = splitKey(k)
    if (FIT_FIELDS.includes(f)) return [recordKey('planview', '*')]
    if (f === 'objects') ids.add(id)
  }
  if (!ids.size) return []
  const next = after()
  const out: RecordKey[] = []
  for (const planId of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if ([...(before[planId] ?? []), ...(next[planId] ?? [])].some((a) => ids.has(a.id))) out.push(recordKey('planview', planId))
  }
  return out
}

// ── a snapshot history, re-laid onto merged state ────────────────────────────────────────────────

/** One step of a snapshot history: the state BEFORE it (on `past`) or AFTER it (on `future`),
 *  under the id its timeline entry names. */
export interface HistoryStep<T> { id: string; snap: T }
export interface History<T> { past: readonly HistoryStep<T>[]; present: T; future: readonly HistoryStep<T>[] }

/** The two states a step moves between: `past[i]` goes from its snapshot to the next one up (the
 *  present for the top step); `future[j]` from the one before it (the present for the first). */
function eachStep<T>(h: History<T>, fn: (id: string, before: T, after: T, dir: 'past' | 'future', snap: T) => void): void {
  h.past.forEach((s, i) => fn(s.id, s.snap, i + 1 < h.past.length ? h.past[i + 1].snap : h.present, 'past', s.snap))
  h.future.forEach((s, j) => fn(s.id, j === 0 ? h.present : h.future[j - 1].snap, s.snap, 'future', s.snap))
}

/**
 * What EACH step of the history touches (`stepTouches`), taken in either direction, by step id —
 * every transition diffed once, so a merge that asks about every entry pays one pass.
 *
 * ⚠️ The top step reaches up to the PRESENT, so it also covers whatever was written without a
 * checkpoint after it (a live-GPS re-route, a Trupp sweep): taking it back restores the snapshot,
 * and the snapshot restores those too. That is what the step does, so that is what it touches.
 */
export function historyTouches<T>(h: History<T>, shape: RecordShape<T>): Map<string, RecordKey[]> {
  const out = new Map<string, RecordKey[]>()
  eachStep(h, (id, before, after) => { out.set(id, stepTouches(before, after, shape)) })
  return out
}

/**
 * `historyTouches`, memoised on the history's identity — the stacks and the present only ever
 * change by replacement, so the same three references mean the same answer.
 */
export function touchesCache<T>(shape: RecordShape<T>): (h: History<T>, id: string) => RecordKey[] | null {
  let seen: { past: unknown; present: unknown; future: unknown; keys: Map<string, RecordKey[]> } | null = null
  return (h, id) => {
    if (!seen || seen.past !== h.past || seen.present !== h.present || seen.future !== h.future) {
      seen = { past: h.past, present: h.present, future: h.future, keys: historyTouches(h, shape) }
    }
    return seen.keys.get(id) ?? null
  }
}

/**
 * The history re-laid onto `next`, the state a merge just produced.
 *
 * Every step `keep` accepts survives as a PATCH: the records it wrote, and only those, are set to
 * the values it wrote them from, over the new state — so each snapshot now agrees with the merge
 * on every record the merge changed, and an undo can no longer carry a pre-merge value back.
 * Every other step is gone: on `past` its effect simply stays (it has become part of the
 * present), on `future` it is never redone.
 *
 * ⚠️ Sound only for steps `keep` accepts that do NOT touch what the merge changed — deciding that
 * is the timeline's job (`UndoTimeline.rebase`), across every domain at once, because a step on
 * one domain may write a record a step on another domain wrote too.
 */
export function rebaseHistory<T>(h: History<T>, next: T, keep: (id: string) => boolean, shape: RecordShape<T>): { past: HistoryStep<T>[]; future: HistoryStep<T>[] } {
  const past: HistoryStep<T>[] = []
  let cur = next
  for (let i = h.past.length - 1; i >= 0; i--) {
    const s = h.past[i]
    if (!keep(s.id)) continue
    const after = i + 1 < h.past.length ? h.past[i + 1].snap : h.present
    cur = shape.patch(cur, recordDiff(after, s.snap, shape), s.snap)
    past.unshift({ id: s.id, snap: cur })
  }
  const future: HistoryStep<T>[] = []
  cur = next
  for (let j = 0; j < h.future.length; j++) {
    const s = h.future[j]
    if (!keep(s.id)) continue
    const before = j === 0 ? h.present : h.future[j - 1].snap
    cur = shape.patch(cur, recordDiff(before, s.snap, shape), s.snap)
    future.push({ id: s.id, snap: cur })
  }
  return { past, future }
}

/**
 * An OPEN gesture's starting point (a Karte drag in progress), re-laid the same way: the records
 * the gesture has written so far keep their pre-gesture value over the merge — unless the merge
 * changed one of them, or one they link to, in which case the gesture so far is part of the
 * present and its step will cover only what follows.
 */
export function rebasePending<T>(start: T, present: T, next: T, shape: RecordShape<T>): T {
  const wrote = recordDiff(present, start, shape)
  if (!wrote.size) return next
  const moved = recordDiff(present, next, shape)
  // what the gesture wrote AND what those values point at (a dragged placard's host) — the same
  // set a finished step would name (stepTouches)
  for (const k of stepTouches(start, present, shape)) if (moved.has(k)) return next
  return shape.patch(next, wrote, start)
}

// ── the merge's undo half, all of it or none of it ─────────────────────────────────────────────

/** One domain's side of a merge: keep the steps the timeline kept, or — when the bookkeeping has
 *  failed — drop its history and still take the merged state. */
export interface MergeUndoDomain {
  rebase: (keep: (step: string) => boolean) => void
  drop: () => void
}

/**
 * The undo half of a hydrate (IncidentWorkspace · applyWorkspace), in one place: learn what the
 * merge changed, let the timeline drop what that invalidated, and have every domain keep exactly
 * the steps whose entries survived — `keep` is a set captured HERE, never read later.
 *
 * ⚠️ All of it or none of it. This is new bookkeeping on the one path that must never fail — a
 * hydrate that throws half-way leaves a device showing a state nobody saved. So any throw falls
 * back to the rule this replaced (25.09.2026): the whole timeline goes, every domain drops its
 * history and takes the merged state wholesale, and every still-standing undo toast is spent.
 * Returns what changed, or `null` after a fallback.
 */
export function carryUndoThroughMerge(
  timeline: Pick<UndoTimeline, 'rebase' | 'steps' | 'clear' | 'peekUndo' | 'entries'>,
  changes: () => Set<RecordKey>,
  domains: readonly MergeUndoDomain[],
  opts: {
    onFail?: (e: unknown) => void
    /** the step ↶ would have taken back is gone — the header now points at something older, and
     *  the operator has to be told once rather than find out by the next tap (F8, 25.09.2026) */
    onTopDropped?: (entry: UndoEntry) => void
  } = {},
): Set<RecordKey> | null {
  const { onFail, onTopDropped } = opts
  const top = timeline.peekUndo()
  const tell = () => {
    if (top && !timeline.entries().past.includes(top)) {
      try { onTopDropped?.(top) } catch (e) { onFail?.(e) }
    }
  }
  try {
    const changed = changes()
    timeline.rebase(changed)
    const live = timeline.steps()
    const keep = (step: string) => live.has(step)
    for (const d of domains) d.rebase(keep)
    noteRemoteChanges(changed)
    tell()
    return changed
  } catch (e) {
    onFail?.(e)
    timeline.clear()
    for (const d of domains) {
      try { d.drop() } catch (inner) { onFail?.(inner) }
    }
    noteRemoteChanges(null)
    tell()
    return null
  }
}

// ── the one-shot doors that outlive a merge: confirm-with-undo toasts ────────────────────────────

interface Watch { keys: readonly RecordKey[]; ok: boolean }
const watching = new Set<Watch>()
/** a toast that is never pressed and never dismissed must not pin its watch forever */
const WATCH_CAP = 64

/**
 * Guard a one-shot inverse (a toast's «Rückgängig») by the records it writes: `ok()` turns false
 * the moment a merge changes one of them (`noteRemoteChanges`). `release()` when the door closes.
 * ⚠️ Module-level on purpose: the toasts are (lib/ui), and the hooks that raise them have no
 * timeline to hand. One Einsatz is open at a time; a stray match only ever makes a toast MORE
 * careful.
 */
export function watchRecords(keys: readonly RecordKey[]): { ok: () => boolean; release: () => void } {
  const w: Watch = { keys, ok: true }
  watching.add(w)
  if (watching.size > WATCH_CAP) {
    const oldest = watching.values().next().value
    if (oldest) { oldest.ok = false; watching.delete(oldest) }
  }
  return { ok: () => w.ok, release: () => { watching.delete(w) } }
}

/** A merge changed these records: every watch that names one of them is spent. `null` = it is not
 *  known what the merge changed (the bookkeeping failed, see `carryUndoThroughMerge`): all are. */
export function noteRemoteChanges(changed: Iterable<RecordKey> | null): void {
  if (changed === null) {
    for (const w of watching) w.ok = false
    watching.clear()
    return
  }
  const m = keyMatcher(changed)
  if (m.empty) return
  for (const w of watching) if (m.meets(w.keys)) { w.ok = false; watching.delete(w) }
}
