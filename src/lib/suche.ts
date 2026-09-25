// «Suche» — Personen + Bereiche (step 1, 24.09.2026). The pure half.
//
// Übung 23.09.2026: missing and found people lived in free-text notes, the names spelt
// differently each time; «abgesucht» was drawn as red lines the app then offered to Trupps as
// their Leitung; and at 20:15 no screen could answer «wer fehlt noch, was ist abgesucht?».
//
// The model (types · SucheDoc) is ONE synced slice with two id-keyed lists. A record says WHO or
// WHERE; what happened to it is its own append-only `log`, and every state here is FOLDED from
// that log — never stored as a status field. So:
//   - two devices recording two things about one person keep both (the merge unions the log by
//     row id, mergeWorkspace · mergeSuche — also for a record both seeded under one derived id);
//   - a correction is a row too (`korrigiert`, `irrtuemlich`), folded like the statuses;
//   - the ↶ of a step removes exactly what that step added (`diffSuche` / `applySuchePatch`), so a
//     row another device or the machine wrote in between is never taken back with it;
//   - replay folds the same patches forward from the audit events (lib/replay · `suche.step`).
//
// Bereiche come into being by themselves: every storey of the Gebäude stack is one area
// «ganzes Geschoss» under a DERIVED id (`sbg:<stack>:<index>`), so two devices opening the Suche
// write the same record — and a REPLACED building is another stack key, whose storeys start
// fresh. A storey is split by NAMES (Trakt 3, Technikraum …) — the parts are rows under it, and
// the storey is abgesucht when all of them are. Nothing is drawn in step 1; `point`/`shape` are
// left empty for step 2.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { fuzzyScore, norm } from './quickPhrases'
import type { SucheBereich, SucheBereichStatus, SucheDoc, SuchePerson, SucheRow } from '../types'

export const emptySuche = (): SucheDoc => ({ personen: [], bereiche: [] })

/** The Gebäude a storey belongs to, as a short stable key: the frozen plan binding of a pack stack,
 *  else the footprint the stack was built from. A building picked again is another key — its
 *  storeys are other records and inherit nothing of the old one's search. '' = no stack. */
export function stackKeyOf(b: { pack?: { bindingId?: string }; src?: unknown; rings?: unknown; ring?: unknown } | null | undefined): string {
  if (!b) return ''
  const raw = b.pack?.bindingId ? `b:${b.pack.bindingId}` : `f:${JSON.stringify(b.src ?? b.rings ?? b.ring ?? '')}`
  // FNV-1a, 32 bit — a label, not a secret: it only has to differ between two buildings
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(36)
}

/** The storey's own area: one id per (stack, index), the same on every device (AGENTS.md · derived
 *  ids). `sbg:k3f9:-1` is the 1. UG of that building. */
export const storeyBereichId = (floor: number, stack = '') => `sbg:${stack}:${floor}`
const STOREY_ID = /^sbg:([^:]*):(-?\d+)$/
export const isStoreyRow = (b: Pick<SucheBereich, 'floor' | 'name'>) => b.floor != null && !b.name
/** Does this area belong to the given stack's storeys? */
const onStack = (b: SucheBereich, stack: string) => b.floor != null && (b.stack ?? '') === stack

/** What a write needs from the world: the shared clock, an id minter, how a storey is named on
 *  this Gebäude (building.floorNames, else «1. OG»), and which Gebäude it is (stackKeyOf). */
export interface SucheCx {
  at: string
  newId: (prefix: string) => string
  floorName: (floor: number) => string
  stack: string
}

/** The Gebäude as the Suche reads it: its storeys, their names, its key. */
export interface SucheStack {
  key: string
  floors: readonly number[]
  floorName: (floor: number) => string
}

// ── the load gate ───────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)

function sanitizeRows(v: unknown): SucheRow[] {
  if (!Array.isArray(v)) return []
  return v.filter((r): r is SucheRow => isObj(r) && typeof r.id === 'string' && typeof r.op === 'string')
    .map((r) => ({ ...r, at: str(r.at) ?? '', text: str(r.text) ?? '' }))
}

/**
 * The slice as the load gate hands it on: anything that is not an id-keyed record with a log is
 * dropped, a missing log is an empty one, and a malformed number is removed rather than kept (a
 * `count` of NaN would print «NaN vermisst» on the head chip). Absent stays absent.
 */
export function sanitizeSuche(raw: unknown): SucheDoc | undefined {
  if (raw == null) return undefined
  if (!isObj(raw)) return emptySuche()
  const personen = (Array.isArray(raw.personen) ? raw.personen : [])
    .filter((p): p is Record<string, unknown> & { id: string } => isObj(p) && typeof p.id === 'string')
    .map((p): SuchePerson => {
      const count = int(p.count)
      const { name: _n, count: _c, floor: _f, ...rest } = p as unknown as SuchePerson
      void _n; void _c; void _f
      return {
        ...rest,
        ...(str(p.name) ? { name: str(p.name) } : {}),
        ...(count != null && count >= 2 ? { count } : {}),
        ...(int(p.floor) != null ? { floor: int(p.floor) } : {}),
        createdAt: str(p.createdAt) ?? '',
        log: sanitizeRows(p.log),
      }
    })
  const bereiche = (Array.isArray(raw.bereiche) ? raw.bereiche : [])
    .filter((b): b is Record<string, unknown> & { id: string } => isObj(b) && typeof b.id === 'string')
    .map((b): SucheBereich => {
      const { floor: _f, name: _n, ...rest } = b as unknown as SucheBereich
      void _f; void _n
      return {
        ...rest,
        ...(int(b.floor) != null ? { floor: int(b.floor) } : {}),
        ...(str(b.name) ? { name: str(b.name) } : {}),
        createdAt: str(b.createdAt) ?? '',
        log: sanitizeRows(b.log),
      }
    })
  return { personen, bereiche }
}

// ── rows, in time order ─────────────────────────────────────────────────────────────────────

/** A log in the order things happened. The merge already sorts, but a log handed over by an
 *  older client or built in a test is folded the same way: `at`, then the log's own order. */
function chrono(log: readonly SucheRow[]): SucheRow[] {
  return log.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.at < b.r.at ? -1 : a.r.at > b.r.at ? 1 : a.i - b.i))
    .map((x) => x.r)
}

// ── Personen ────────────────────────────────────────────────────────────────────────────────

/** `irrtuemlich` = withdrawn («irrtümlich erfasst»): the record stays, it counts nowhere. */
export type PersonStatus = 'vermisst' | 'gefunden' | 'uebergeben' | 'entwarnt' | 'irrtuemlich'

export interface PersonView {
  id: string
  /** the name as the record now says it (after corrections) — absent when none was given */
  name?: string
  /** the name as written (or as corrected), else «Person ohne Namen» / «Gruppe ohne Namen» */
  label: string
  group: boolean
  /** how many people the record stands for (1 for a single person) */
  count: number
  /** people found (gefunden or übergeben) */
  found: number
  /** people handed over */
  handed: number
  /** people still missing — 0 once found, entwarnt or withdrawn */
  missing: number
  status: PersonStatus
  /** when it was reported missing — ABSENT for somebody found who was never reported («+ Gefunden») */
  vermisstAt?: string
  /** the first thing that happened to the record — the list's order */
  firstAt: string
  floor?: number
  wo?: string
  quelle?: string
  /** the LATEST find */
  foundAt?: string
  foundTrupp?: string
  foundTruppId?: string
  foundFloor?: number
  foundWo?: string
  /** the latest handover */
  handedAt?: string
  an?: string
  entwarntAt?: string
  withdrawnAt?: string
  rows: SucheRow[]
}

export function personLabel(p: Pick<SuchePerson, 'name' | 'count'>): string {
  const C = appConfig.copy.suche
  return p.name?.trim() || (p.count ? C.groupUnnamed : C.unnamed)
}

/** The record as its `korrigiert` rows leave it — name, count and «zuletzt gesehen». */
function corrected(p: SuchePerson): Pick<SuchePerson, 'name' | 'count' | 'floor' | 'wo'> {
  const out: Pick<SuchePerson, 'name' | 'count' | 'floor' | 'wo'> = { name: p.name, count: p.count, floor: p.floor, wo: p.wo }
  for (const r of chrono(p.log)) {
    if (r.op !== 'korrigiert' || !r.set) continue
    if ('name' in r.set) out.name = r.set.name?.trim() || undefined
    if ('count' in r.set) out.count = r.set.count && r.set.count >= 2 ? r.set.count : undefined
    if ('floor' in r.set) out.floor = r.set.floor ?? undefined
    if ('wo' in r.set) out.wo = r.set.wo?.trim() || undefined
  }
  return out
}

/**
 * Fold one person's log into what the list, the head chip and the Rapport read.
 *
 * A single person is whatever its latest row says. A GROUP counts: every `gefunden` row adds its
 * `n` (capped at the group's size), every handover likewise, and the group is «gefunden» only when
 * all of it is — «20 / 22 gefunden» is still two people missing, and the head chip says so.
 * `entwarnt` stands for the whole record (nobody was inside after all); `irrtuemlich` withdraws it
 * — it was never a person to look for, and counts nowhere at all.
 */
export function personView(p: SuchePerson): PersonView {
  const fix = corrected(p)
  const count = fix.count && fix.count >= 2 ? fix.count : 1
  const group = count >= 2
  let found = 0
  let handed = 0
  let entwarnt: string | undefined
  let withdrawn: string | undefined
  let vermisstAt: string | undefined
  const rows = chrono(p.log)
  const v: Partial<PersonView> = {}
  for (const r of rows) {
    if (r.op === 'vermisst') {
      vermisstAt ??= r.at
      // re-reported missing (a single person only): the earlier find no longer stands
      if (!group) { found = 0; handed = 0; entwarnt = undefined }
    } else if (r.op === 'gefunden') {
      const n = group ? Math.max(1, r.n ?? 1) : 1
      found = Math.min(count, found + n)
      entwarnt = undefined
      Object.assign(v, { foundAt: r.at, foundTrupp: r.trupp, foundTruppId: r.truppId, foundFloor: r.floor, foundWo: r.wo })
      // «weiter an» in the same breath: the find and its handover are one row
      if (r.an) { handed = Math.min(count, handed + n); Object.assign(v, { handedAt: r.at, an: r.an }) }
    } else if (r.op === 'uebergeben') {
      const n = group ? Math.max(1, r.n ?? 1) : 1
      handed = Math.min(count, handed + n)
      // a handover of somebody nobody booked as found still found them
      found = Math.max(found, handed)
      Object.assign(v, { handedAt: r.at, an: r.an })
    } else if (r.op === 'entwarnt') {
      entwarnt = r.at
    } else if (r.op === 'irrtuemlich') {
      withdrawn = r.at
    }
  }
  const off = !!entwarnt || !!withdrawn
  const status: PersonStatus = withdrawn ? 'irrtuemlich' : entwarnt ? 'entwarnt'
    : found >= count ? (handed >= count ? 'uebergeben' : 'gefunden')
    : 'vermisst'
  return {
    ...v,
    id: p.id,
    label: personLabel(fix),
    name: fix.name,
    group,
    count,
    found: off ? 0 : found,
    handed: off ? 0 : handed,
    missing: off ? 0 : count - found,
    status,
    vermisstAt,
    firstAt: rows[0]?.at ?? p.createdAt,
    floor: fix.floor,
    wo: fix.wo,
    quelle: p.quelle?.trim() || undefined,
    entwarntAt: entwarnt,
    withdrawnAt: withdrawn,
    rows,
  }
}

/** Order for the list: still missing first (longest missing on top — the position carries the
 *  age), then found, handed over, entwarnt, and a withdrawn record last. */
const STATUS_ORDER: Record<PersonStatus, number> = { vermisst: 0, gefunden: 1, uebergeben: 2, entwarnt: 3, irrtuemlich: 4 }
export function personenViews(doc: SucheDoc): PersonView[] {
  return doc.personen.map(personView).sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || a.firstAt.localeCompare(b.firstAt)
    || a.id.localeCompare(b.id))
}

/** People still missing, across the whole list — the head chip, the rail badge, the Abschluss. */
export function vermisstCount(doc: SucheDoc | undefined): number {
  if (!doc) return 0
  return doc.personen.reduce((n, p) => n + personView(p).missing, 0)
}

/** «Gerettete» counted from the list: everybody found or handed over, a group by its count.
 *  An entwarnt or withdrawn record rescues nobody. */
export function geretteteFromSuche(doc: SucheDoc | undefined): number {
  if (!doc) return 0
  return doc.personen.reduce((n, p) => n + personView(p).found, 0)
}

// ── Bereiche ────────────────────────────────────────────────────────────────────────────────

export interface BereichView {
  id: string
  floor?: number
  name?: string
  /** the storey's own row («ganzes Geschoss» / «übriges Geschoss») */
  storey: boolean
  status: SucheBereichStatus
  /** who searches / searched it, as the row said it («Trupp 4») */
  trupp?: string
  truppId?: string
  /** when the current status was set ('' for the implicit «offen») */
  statusAt: string
  fund: boolean
  /** the label UNDER its storey heading: «Trakt 3», «ganzes Geschoss», «übriges Geschoss» */
  short: string
  /** the label on its own, as a Verlauf row says it: «1. OG Trakt 3», «1. OG» */
  full: string
  /** not saved yet: a storey of the stack nobody has opened the Suche for (read-only devices
   *  see the storeys too, and a first write saves the row under its derived id) */
  virtual?: boolean
  rows: SucheRow[]
}

/** The area's status, folded from its rows. `doc` adds the finds booked on PEOPLE: a `gefunden`
 *  row names the area it happened in, and that is what makes the area wear «Fund». */
export function bereichStatusOf(b: SucheBereich, doc?: SucheDoc): { status: SucheBereichStatus; trupp?: string; truppId?: string; at: string; fund: boolean } {
  let status: SucheBereichStatus = 'offen'
  let trupp: string | undefined
  let truppId: string | undefined
  let at = ''
  let fund = false
  for (const r of chrono(b.log)) {
    if (r.op === 'status' && r.status) {
      status = r.status
      at = r.at
      // «in Arbeit · T4» and «abgesucht · T4» keep their Trupp; «offen» clears it
      trupp = r.status === 'offen' ? undefined : r.trupp
      truppId = r.status === 'offen' ? undefined : r.truppId
    } else if (r.op === 'fund') fund = true
  }
  if (!fund && doc) {
    fund = doc.personen.some((p) => p.log.some((r) => r.op === 'gefunden' && r.bereichId === b.id)
      && !p.log.some((r) => r.op === 'irrtuemlich'))
  }
  return { status, trupp, truppId, at, fund }
}

/** The named parts of one storey of one stack. */
const partsOf = (doc: SucheDoc, floor: number, stack: string) => doc.bereiche.filter((b) => onStack(b, stack) && b.floor === floor && !!b.name)

export function bereichView(doc: SucheDoc, b: SucheBereich, floorName: (f: number) => string, virtual = false): BereichView {
  const C = appConfig.copy.suche
  const st = bereichStatusOf(b, doc)
  const storey = isStoreyRow(b)
  const split = storey && partsOf(doc, b.floor!, b.stack ?? '').length > 0
  const short = storey ? (split ? C.uebrigesGeschoss : C.ganzesGeschoss) : (b.name ?? '')
  const full = b.floor == null ? (b.name ?? '')
    : storey ? (split ? `${floorName(b.floor)} ${C.uebrigesGeschoss}` : floorName(b.floor))
    : fillTemplate(C.rowPart, { floor: floorName(b.floor), name: b.name ?? '' })
  return {
    id: b.id, floor: b.floor, name: b.name, storey,
    status: st.status, trupp: st.trupp, truppId: st.truppId, statusAt: st.at, fund: st.fund,
    short, full, virtual: virtual || undefined, rows: chrono(b.log),
  }
}

export interface SucheGroup {
  /** `f<index>`, or `none` for the areas without a storey */
  key: string
  floor: number | null
  label: string
  /** the storey's own record id, null for the no-storey group */
  storeyId: string | null
  /** the areas that COUNT — the storey row leaves the list once its parts cover it (`ohneRest`) */
  units: BereichView[]
  /** the storey row even when it is not a unit */
  storeyRow?: BereichView
  hasParts: boolean
  done: number
  total: number
  complete: boolean
}

/** A storey's record — the one saved, else the virtual one under the id every device derives. */
function storeyRecord(doc: SucheDoc, f: number, stack: string): { rec: SucheBereich; virtual: boolean } {
  const id = storeyBereichId(f, stack)
  const own = doc.bereiche.find((b) => b.id === id) ?? doc.bereiche.find((b) => onStack(b, stack) && b.floor === f && !b.name)
  return own ? { rec: own, virtual: false } : { rec: { id, floor: f, stack, createdAt: '', log: [] }, virtual: true }
}

/**
 * The Bereiche as the list shows them: one group per storey of THIS Gebäude, top to bottom like
 * the stack, then the areas without a storey. A storey that has records but is no longer on the
 * stack still shows (its record is not ours to hide); a replaced building's storeys do not.
 *
 * A storey nobody has seeded yet appears as a VIRTUAL «ganzes Geschoss · offen» — so a device
 * that may not write (the `el`, a viewer) sees the same gaps an editor does, and the first write
 * saves it under the id every device would have given it.
 */
export function sucheGroups(doc: SucheDoc, stack: SucheStack): SucheGroup[] {
  const C = appConfig.copy.suche
  const storeys = [...new Set([...stack.floors, ...doc.bereiche.filter((b) => onStack(b, stack.key)).map((b) => b.floor!)])]
    .sort((a, b) => b - a)
  const groups: SucheGroup[] = storeys.map((f) => {
    const { rec, virtual } = storeyRecord(doc, f, stack.key)
    const storeyRow = bereichView(doc, rec, stack.floorName, virtual)
    const parts = partsOf(doc, f, stack.key).filter((b) => b.id !== rec.id).map((b) => bereichView(doc, b, stack.floorName))
    const units = [...parts, ...(parts.length && rec.ohneRest ? [] : [storeyRow])]
    const done = units.filter((u) => u.status === 'abgesucht').length
    return {
      key: `f${f}`, floor: f, label: stack.floorName(f), storeyId: rec.id,
      units, storeyRow, hasParts: parts.length > 0,
      done, total: units.length, complete: units.length > 0 && done === units.length,
    }
  })
  const loose = doc.bereiche.filter((b) => b.floor == null).map((b) => bereichView(doc, b, stack.floorName))
  if (loose.length) {
    const done = loose.filter((u) => u.status === 'abgesucht').length
    groups.push({ key: 'none', floor: null, label: C.ohneGeschoss, storeyId: null, units: loose, hasParts: false, done, total: loose.length, complete: done === loose.length })
  }
  return groups
}

export function sucheProgress(groups: readonly SucheGroup[]): { done: number; total: number } {
  return groups.reduce((a, g) => ({ done: a.done + g.done, total: a.total + g.total }), { done: 0, total: 0 })
}

/** The storey's progress as its label on the stack carries it: «2/4». */
export function storeyBadges(groups: readonly SucheGroup[]): Record<number, { text: string; complete: boolean; active: boolean }> {
  const out: Record<number, { text: string; complete: boolean; active: boolean }> = {}
  for (const g of groups) {
    if (g.floor == null || !g.total) continue
    out[g.floor] = {
      text: fillTemplate(appConfig.copy.suche.progress, { done: g.done, total: g.total }),
      complete: g.complete,
      active: g.units.some((u) => u.status === 'inArbeit'),
    }
  }
  return out
}

/**
 * The questions standing on the list: an area still «in Arbeit» with a Trupp that is out
 * («Trupp 4 raus – abgesucht? Ja / Teilweise / Nein»). DERIVED, never stored and never modal —
 * so it survives a reload, reaches every editor device (the Raus may have been booked on a
 * handed-over board), and a question nobody answers writes nothing at all.
 */
export function pendingAsks(groups: readonly SucheGroup[], truppOut: (truppId: string) => boolean): BereichView[] {
  return groups.flatMap((g) => g.units).filter((u) => u.status === 'inArbeit' && !!u.truppId && truppOut(u.truppId))
}

// ── writes: each returns the NEW doc (or the same object when nothing changed) + the rows ───

/** Seed one «ganzes Geschoss» per storey of the stack. IDEMPOTENT by construction — the same
 *  doc comes back when every storey already has its row, so a caller that runs this on open can
 *  never lay a step or a save for nothing (AGENTS.md · a machine writer is idempotent). */
export function ensureStoreyBereiche(doc: SucheDoc, floors: readonly number[], at: string, stack: string): SucheDoc {
  const have = new Set(doc.bereiche.filter((b) => isStoreyRow(b) && onStack(b, stack)).map((b) => b.floor))
  const add = [...new Set(floors)].filter((f) => !have.has(f))
    .map((f): SucheBereich => ({ id: storeyBereichId(f, stack), floor: f, stack, createdAt: at, log: [] }))
  return add.length ? { ...doc, bereiche: [...doc.bereiche, ...add] } : doc
}

const appendRow = <T extends { id: string; log: SucheRow[] }>(list: T[], id: string, row: SucheRow): T[] =>
  list.map((x) => (x.id === id ? { ...x, log: [...x.log, row] } : x))

export interface VermisstInput {
  name?: string
  count?: number
  floor?: number
  wo?: string
  quelle?: string
}

const seg = (tpl: string, v: Record<string, string | number>, on: unknown) => (on ? fillTemplate(tpl, v) : '')

/** «Klasse 3c (22 Pers.)» — a group says its size wherever it is named in a row */
function nameWithCount(p: Pick<SuchePerson, 'name' | 'count'>): string {
  const C = appConfig.copy.suche
  return personLabel(p) + (p.count && p.count >= 2 ? ` (${fillTemplate(C.groupPersons, { n: p.count })})` : '')
}

/** «Vermisst: Klasse 3c (22 Pers.) · zuletzt 1. OG Werkraum · Quelle Hauswart» */
export function vermisstText(p: VermisstInput, floorName: (f: number) => string): string {
  const C = appConfig.copy.suche
  const where = [p.floor != null ? floorName(p.floor) : '', p.wo?.trim() ?? ''].filter(Boolean).join(' ')
  return fillTemplate(C.rowVermisst, { name: nameWithCount(p) })
    + seg(C.rowZuletzt, { wo: where }, where)
    + seg(C.rowQuelle, { quelle: p.quelle?.trim() ?? '' }, p.quelle?.trim())
}

function newPerson(input: VermisstInput, cx: SucheCx, log: SucheRow[], id: string): SuchePerson {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const clean = (s?: string) => s?.trim() || undefined
  return {
    id,
    ...(clean(input.name) ? { name: clean(input.name) } : {}),
    ...(count ? { count } : {}),
    ...(input.floor != null ? { floor: input.floor } : {}),
    ...(clean(input.wo) ? { wo: clean(input.wo) } : {}),
    ...(clean(input.quelle) ? { quelle: clean(input.quelle) } : {}),
    createdAt: cx.at,
    log,
  }
}

export function addPerson(doc: SucheDoc, input: VermisstInput, cx: SucheCx): { doc: SucheDoc; person: SuchePerson; row: SucheRow } {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'vermisst', text: vermisstText({ ...input, count }, cx.floorName) }
  const person = newPerson(input, cx, [row], cx.newId('sp'))
  return { doc: { ...doc, personen: [...doc.personen, person] }, person, row }
}

export interface GefundenInput {
  /** how many of a group (ignored for a single person) */
  n?: number
  trupp?: string
  truppId?: string
  floor?: number
  wo?: string
  /** optional handover in the same breath («weiter an») — on the SAME row */
  an?: string
}

/** Which area a find on this storey belongs to: a part whose name the place starts with
 *  («Technikraum» → «Technik…»), else the storey itself (virtual or not — the id is derived). */
function fundTarget(doc: SucheDoc, floor: number, wo: string | undefined, stack: string): string {
  const w = norm(wo ?? '')
  const part = w ? partsOf(doc, floor, stack).find((b) => w.startsWith(norm(b.name!)) || norm(b.name!).startsWith(w)) : undefined
  return part?.id ?? storeyRecord(doc, floor, stack).rec.id
}

/** The ONE row a find writes: «Gefunden: Tim Muster · 1. OG Technikraum · Trupp 3 · an
 *  Rettungsdienst». It names the area it happened in, which is what makes that area wear «Fund». */
function gefundenRow(doc: SucheDoc, label: string, group: boolean, n: number | undefined, input: GefundenInput, cx: SucheCx): SucheRow {
  const C = appConfig.copy.suche
  const where = [input.floor != null ? cx.floorName(input.floor) : '', input.wo?.trim() ?? ''].filter(Boolean).join(' ')
  const an = input.an?.trim()
  const text = (group ? fillTemplate(C.rowGefundenGroup, { n: n ?? 1, name: label }) : fillTemplate(C.rowGefunden, { name: label }))
    + seg(C.rowWo, { wo: where }, where)
    + seg(C.rowTrupp, { trupp: input.trupp ?? '' }, input.trupp)
    + seg(C.rowAn, { an: an ?? '' }, an)
  return {
    id: cx.newId('sr'), at: cx.at, op: 'gefunden', text,
    ...(n != null ? { n } : {}),
    ...(input.trupp ? { trupp: input.trupp } : {}),
    ...(input.truppId ? { truppId: input.truppId } : {}),
    ...(input.floor != null ? { floor: input.floor, bereichId: fundTarget(doc, input.floor, input.wo, cx.stack) } : {}),
    ...(input.wo?.trim() ? { wo: input.wo.trim() } : {}),
    ...(an ? { an } : {}),
  }
}

export function personGefunden(doc: SucheDoc, personId: string, input: GefundenInput, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const view = personView(p)
  const n = view.group ? Math.max(1, Math.min(view.count - view.found, Math.round(input.n ?? (view.count - view.found)))) : undefined
  const row = gefundenRow(doc, view.label, view.group, n, input, cx)
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** «+ Gefunden»: somebody found who was never reported missing. ONE row, «Gefunden: …» — never a
 *  «Vermisst: …» with a time nobody reported. */
export function addFoundPerson(doc: SucheDoc, input: VermisstInput, found: GefundenInput, cx: SucheCx): { doc: SucheDoc; person: SuchePerson; row: SucheRow } {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const label = nameWithCount({ name: input.name, count })
  const row = gefundenRow(doc, label, !!count, count, found, cx)
  const person = newPerson({ ...input, floor: input.floor ?? found.floor, wo: input.wo ?? found.wo }, cx, [row], cx.newId('sp'))
  return { doc: { ...doc, personen: [...doc.personen, person] }, person, row }
}

export function personUebergeben(doc: SucheDoc, personId: string, input: { an: string; n?: number }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const p = doc.personen.find((x) => x.id === personId)
  const an = input.an.trim()
  if (!p || !an) return { doc, rows: [] }
  const view = personView(p)
  const n = view.group ? Math.max(1, Math.min(view.count, Math.round(input.n ?? Math.max(1, view.found - view.handed)))) : undefined
  const text = view.group ? fillTemplate(C.rowUebergebenGroup, { n: n ?? 1, name: view.label, an }) : fillTemplate(C.rowUebergeben, { name: view.label, an })
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'uebergeben', text, an, ...(n != null ? { n } : {}) }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

export function personEntwarnt(doc: SucheDoc, personId: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'entwarnt', text: fillTemplate(appConfig.copy.suche.rowEntwarnt, { name: personView(p).label }) }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** How a person reads in a correction row: «Klasse 3c (22 Pers.) · zuletzt 2. OG» */
function personSummary(v: Pick<SuchePerson, 'name' | 'count' | 'floor' | 'wo'>, floorName: (f: number) => string): string {
  const C = appConfig.copy.suche
  const where = [v.floor != null ? floorName(v.floor) : '', v.wo ?? ''].filter(Boolean).join(' ')
  return nameWithCount(v) + seg(C.rowZuletzt, { wo: where }, where)
}

/**
 * «Korrigiert: Tim Mustr → Tim Muster · zuletzt 1. OG» — the name, the size of a group or where the
 * person was last seen, as a ROW: the record keeps what was first said, the fold shows what is true.
 * Only what actually changed is carried; nothing changed writes nothing.
 */
export function personKorrigiert(doc: SucheDoc, personId: string, next: { name?: string; count?: number; floor?: number; wo?: string }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const cur = corrected(p)
  const want = {
    name: next.name?.trim() || undefined,
    count: next.count && next.count >= 2 ? Math.round(next.count) : undefined,
    floor: next.floor,
    wo: next.wo?.trim() || undefined,
  }
  const set: NonNullable<SucheRow['set']> = {}
  if (want.name !== cur.name) set.name = want.name ?? ''
  if (want.count !== cur.count) set.count = want.count ?? 1
  if (want.floor !== cur.floor) set.floor = want.floor ?? null
  if (want.wo !== cur.wo) set.wo = want.wo ?? ''
  if (!Object.keys(set).length) return { doc, rows: [] }
  const text = fillTemplate(appConfig.copy.suche.rowKorrigiert, { from: personSummary(cur, cx.floorName), to: personSummary(want, cx.floorName) })
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'korrigiert', text, set }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** «Irrtümlich erfasst: Tim Muster» — the record is withdrawn; it counts nowhere from here on. */
export function personIrrtuemlich(doc: SucheDoc, personId: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p || p.log.some((r) => r.op === 'irrtuemlich')) return { doc, rows: [] }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'irrtuemlich', text: fillTemplate(appConfig.copy.suche.rowIrrtuemlich, { name: personView(p).label }) }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** The area a write appends to, seeding a virtual storey row first (under its derived id). */
function bereichFor(doc: SucheDoc, id: string, at: string): { doc: SucheDoc; b?: SucheBereich } {
  const m = STOREY_ID.exec(id)
  const seeded = m && !doc.bereiche.some((b) => b.id === id) ? ensureStoreyBereiche(doc, [Number(m[2])], at, m[1]) : doc
  return { doc: seeded, b: seeded.bereiche.find((b) => b.id === id) }
}

/**
 * One tap on an area's status: «1. OG Trakt 3 abgesucht · Trupp 4». Setting the status it
 * already has (same Trupp) writes nothing — a second tap is not a second event.
 */
export function setBereichStatus(doc: SucheDoc, id: string, status: SucheBereichStatus, trupp: { label?: string; id?: string } | undefined, cx: SucheCx, note?: string): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const { doc: d, b } = bereichFor(doc, id, cx.at)
  if (!b) return { doc, rows: [] }
  const cur = bereichStatusOf(b)
  // «abgesucht» after «in Arbeit · Trupp 4» is Trupp 4's unless somebody says otherwise
  const label = status === 'offen' ? undefined : (trupp?.label ?? cur.trupp)
  const tid = status === 'offen' ? undefined : (trupp?.label ? trupp.id : cur.truppId)
  if (cur.status === status && cur.trupp === label && !note) return { doc, rows: [] }
  const view = bereichView(d, b, cx.floorName)
  // `note` says what the status alone cannot — «teilweise abgesucht» at a Trupp's Raus
  const text = fillTemplate(C.rowBereich, { bereich: view.full, status: note ?? C.bereichStatus[status] }) + seg(C.rowTrupp, { trupp: label ?? '' }, label)
  const row: SucheRow = {
    id: cx.newId('sr'), at: cx.at, op: 'status', status, text,
    ...(label ? { trupp: label } : {}),
    ...(label && tid ? { truppId: tid } : {}),
  }
  return { doc: { ...d, bereiche: appendRow(d.bereiche, id, row) }, rows: [row] }
}

/** «Fund: 1. OG Technikraum» — the area's own mark, set on the area (a find booked on a PERSON
 *  marks its area through its own row instead). */
export function markFund(doc: SucheDoc, id: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const { doc: seeded, b } = bereichFor(doc, id, cx.at)
  if (!b || bereichStatusOf(b, doc).fund) return { doc, rows: [] }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'fund', text: fillTemplate(C.rowFund, { bereich: bereichView(seeded, b, cx.floorName).full }) }
  return { doc: { ...seeded, bereiche: appendRow(seeded.bereiche, id, row) }, rows: [row] }
}

/**
 * Split a storey by NAMES: each new name becomes a part under it; a name the storey already has
 * is skipped (case and spacing do not make a second «Trakt 3»). `keepRest: false` says the parts
 * cover the whole storey. The storey row carries the one «geteilt» row, so the step is one row.
 */
export function splitStorey(doc: SucheDoc, floor: number, names: readonly string[], keepRest: boolean, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; created: SucheBereich[] } {
  const C = appConfig.copy.suche
  const sid = storeyBereichId(floor, cx.stack)
  let d = bereichFor(doc, sid, cx.at).doc
  const have = new Set(partsOf(d, floor, cx.stack).map((b) => norm(b.name!)))
  const created: SucheBereich[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name || have.has(norm(name))) continue
    have.add(norm(name))
    created.push({ id: cx.newId('sb'), floor, name, stack: cx.stack, createdAt: cx.at, log: [] })
  }
  const own = d.bereiche.find((b) => b.id === sid)
  const restChange = !!own && !!own.ohneRest === keepRest
  if (!created.length && !restChange) return { doc, rows: [], created }
  const text = created.length
    ? fillTemplate(C.rowGeteilt, { floor: cx.floorName(floor), names: created.map((b) => b.name).join(', ') })
    : fillTemplate(keepRest ? C.rowMitRest : C.rowOhneRest, { floor: cx.floorName(floor) })
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'geteilt', text }
  const stamp = (b: SucheBereich): SucheBereich => {
    // absent, never `undefined`: the merge compares by JSON, and a key that says nothing is noise
    const { ohneRest: _was, ...rest } = b
    void _was
    return { ...rest, ...(keepRest ? {} : { ohneRest: true }), log: [...b.log, row] }
  }
  d = { ...d, bereiche: [...d.bereiche.map((b) => (b.id === sid ? stamp(b) : b)), ...created] }
  return { doc: d, rows: [row], created }
}

/** «übriges Geschoss» out of / back into the count, on its own (the storey's row). */
export function setOhneRest(doc: SucheDoc, floor: number, ohneRest: boolean, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const r = splitStorey(doc, floor, [], !ohneRest, cx)
  return { doc: r.doc, rows: r.rows }
}

export function renameBereich(doc: SucheDoc, id: string, name: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const b = doc.bereiche.find((x) => x.id === id)
  const next = name.trim()
  if (!b || !b.name || !next || next === b.name) return { doc, rows: [] }
  const from = bereichView(doc, b, cx.floorName).full
  const to = bereichView(doc, { ...b, name: next }, cx.floorName).full
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'umbenannt', text: fillTemplate(appConfig.copy.suche.rowUmbenannt, { from, to }) }
  return { doc: { ...doc, bereiche: doc.bereiche.map((x) => (x.id === id ? { ...x, name: next, log: [...x.log, row] } : x)) }, rows: [row] }
}

/** «+ Bereich» with a name — a part of a storey, or (no Gebäude) an area of its own. An existing
 *  name is found, not duplicated. */
export function addBereich(doc: SucheDoc, input: { name: string; floor?: number }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; id: string | null } {
  const name = input.name.trim()
  if (!name) return { doc, rows: [], id: null }
  const found = findBereichByName(doc, name, input.floor, { key: cx.stack, floors: [], floorName: cx.floorName })
  if (found) return { doc, rows: [], id: found }
  if (input.floor != null) {
    const r = splitStorey(doc, input.floor, [name], true, cx)
    return { doc: r.doc, rows: r.rows, id: r.created[0]?.id ?? null }
  }
  const b: SucheBereich = { id: cx.newId('sb'), name, createdAt: cx.at, log: [] }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'geteilt', text: fillTemplate(appConfig.copy.suche.rowAngelegt, { name }) }
  return { doc: { ...doc, bereiche: [...doc.bereiche, { ...b, log: [row] }] }, rows: [row], id: b.id }
}

/**
 * The area a typed name means — a Trupp's Ziel («Trakt 3», «1. OG», «EG Trakt 3», «Aula», and
 * every label the Ziel chips offer, «1. OG übriges Geschoss» included). A storey's own label —
 * bare, «ganzes Geschoss» or «übriges Geschoss» — is that storey's row, saved or VIRTUAL (the id
 * is derived); «<storey> <part>» or a bare part name on the given storey is that part.
 */
export function findBereichByName(doc: SucheDoc, text: string, floor: number | undefined, stack: SucheStack): string | null {
  const C = appConfig.copy.suche
  const t = norm(text.trim().replace(/\s+/g, ' '))
  if (!t) return null
  const storeys = [...new Set([...stack.floors, ...doc.bereiche.filter((b) => onStack(b, stack.key)).map((b) => b.floor!)])]
  for (const f of storeys) {
    const fl = norm(stack.floorName(f))
    if (t === fl || t === `${fl} ${norm(C.ganzesGeschoss)}` || t === `${fl} ${norm(C.uebrigesGeschoss)}`) return storeyRecord(doc, f, stack.key).rec.id
    for (const b of partsOf(doc, f, stack.key)) {
      const n = norm(b.name!)
      if (t === `${fl} ${n}` || (t === n && (floor == null || floor === f))) return b.id
    }
  }
  const loose = doc.bereiche.find((b) => b.floor == null && !!b.name && norm(b.name) === t)
  return loose?.id ?? null
}

/**
 * A Trupp's Ziel as an area: «1. OG Trakt 3» → storey 1, part «Trakt 3»; «EG» → the storey
 * itself; «Aula» → a part named «Aula» on `floor` (the storey the Trupp's marker stands on), or an
 * area without a storey when that is unknown too.
 */
export function parseZiel(text: string, floors: readonly number[], floorName: (f: number) => string, floor?: number): { floor?: number; name?: string } {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return {}
  // the longest storey label first, so «1. OG» never matches inside «11. OG»
  for (const f of [...floors].sort((a, b) => floorName(b).length - floorName(a).length)) {
    const fl = floorName(f)
    if (norm(t) === norm(fl)) return { floor: f }
    if (norm(t).startsWith(`${norm(fl)} `)) return { floor: f, name: t.slice(fl.length).trim() || undefined }
  }
  return { floor, name: t }
}

/**
 * The area a Trupp's Ziel names, CREATING it when it is new — resolved against the doc handed in,
 * which must be the writer's latest (the storeys the same Trupp's save just seeded included).
 */
export function zielBereich(doc: SucheDoc, ziel: string, markerFloor: number | undefined, stack: SucheStack, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; id: string | null } {
  const hit = findBereichByName(doc, ziel, markerFloor, stack)
  if (hit) return { doc, rows: [], id: hit }
  const z = parseZiel(ziel, stack.floors, stack.floorName, markerFloor)
  if (z.floor != null && !z.name) return { doc, rows: [], id: storeyBereichId(z.floor, stack.key) }
  if (!z.name) return { doc, rows: [], id: null }
  return addBereich(doc, { name: z.name, floor: z.floor }, cx)
}

// ── undo: a step takes back exactly what it added ───────────────────────────────────────────

type Kind = 'personen' | 'bereiche'
export interface SuchePatch {
  /** records the step created, as it created them (with their rows) */
  created: { kind: Kind; rec: SuchePerson | SucheBereich }[]
  /** rows the step appended to records that already existed */
  rows: { kind: Kind; owner: string; row: SucheRow }[]
  /** plain fields the step changed on existing records (rename, ohneRest) */
  fields: { kind: Kind; id: string; before: Record<string, unknown>; after: Record<string, unknown> }[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What turned `a` into `b`: the records added, the rows appended, the fields changed. */
export function diffSuche(a: SucheDoc, b: SucheDoc): SuchePatch {
  const out: SuchePatch = { created: [], rows: [], fields: [] }
  for (const kind of ['personen', 'bereiche'] as const) {
    const before = new Map<string, SuchePerson | SucheBereich>((a[kind] as (SuchePerson | SucheBereich)[]).map((x) => [x.id, x]))
    for (const rec of b[kind] as (SuchePerson | SucheBereich)[]) {
      const old = before.get(rec.id)
      if (!old) { out.created.push({ kind, rec }); continue }
      const had = new Set(old.log.map((r) => r.id))
      for (const row of rec.log) if (!had.has(row.id)) out.rows.push({ kind, owner: rec.id, row })
      const f0: Record<string, unknown> = {}
      const f1: Record<string, unknown> = {}
      const o = old as unknown as Record<string, unknown>
      const n = rec as unknown as Record<string, unknown>
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
        if (k === 'log' || same(o[k], n[k])) continue
        f0[k] = o[k]; f1[k] = n[k]
      }
      if (Object.keys(f1).length) out.fields.push({ kind, id: rec.id, before: f0, after: f1 })
    }
  }
  return out
}

export const patchEmpty = (p: SuchePatch) => !p.created.length && !p.rows.length && !p.fields.length

/** Every row a patch carries, in the order they were written — what its Verlauf lines say. */
export function patchRows(p: SuchePatch): SucheRow[] {
  return [...p.created.flatMap((c) => c.rec.log), ...p.rows.map((r) => r.row)].sort((x, y) => x.at.localeCompare(y.at))
}

const setFields = <T extends object>(rec: T, vals: Record<string, unknown>): T => {
  const out = { ...rec } as Record<string, unknown>
  for (const [k, v] of Object.entries(vals)) { if (v === undefined) delete out[k]; else out[k] = v }
  return out as T
}

/**
 * Take a step back (`undo`) or put it back (`redo`) — touching ONLY what the step itself added.
 * A row the machine or another device wrote in between stays, and so does a record the step did
 * not create; a field is set back only while it still holds what the step put there.
 */
export function applySuchePatch(doc: SucheDoc, p: SuchePatch, dir: 'undo' | 'redo'): SucheDoc {
  const next: SucheDoc = { personen: [...doc.personen], bereiche: [...doc.bereiche] }
  for (const kind of ['personen', 'bereiche'] as const) {
    let list = next[kind] as (SuchePerson | SucheBereich)[]
    const created = p.created.filter((c) => c.kind === kind)
    const rows = p.rows.filter((r) => r.kind === kind)
    const fields = p.fields.filter((f) => f.kind === kind)
    if (dir === 'undo') {
      const gone = new Set(created.map((c) => c.rec.id))
      const drop = new Set(rows.map((r) => r.row.id))
      list = list.filter((x) => !gone.has(x.id)).map((x) => {
        const f = fields.find((ff) => ff.id === x.id)
        let rec = x.log.some((r) => drop.has(r.id)) ? { ...x, log: x.log.filter((r) => !drop.has(r.id)) } : x
        if (f) {
          const back = Object.fromEntries(Object.entries(f.before).filter(([k]) => same((rec as unknown as Record<string, unknown>)[k], f.after[k])))
          if (Object.keys(back).length) rec = setFields(rec, back)
        }
        return rec
      })
    } else {
      const have = new Set(list.map((x) => x.id))
      list = [...list, ...created.filter((c) => !have.has(c.rec.id)).map((c) => c.rec)]
      list = list.map((x) => {
        const mine = rows.filter((r) => r.owner === x.id && !x.log.some((l) => l.id === r.row.id)).map((r) => r.row)
        const f = fields.find((ff) => ff.id === x.id)
        let rec = mine.length ? { ...x, log: [...x.log, ...mine] } : x
        if (f) {
          const fwd = Object.fromEntries(Object.entries(f.after).filter(([k]) => same((rec as unknown as Record<string, unknown>)[k], f.before[k])))
          if (Object.keys(fwd).length) rec = setFields(rec, fwd)
        }
        return rec
      })
    }
    ;(next as unknown as Record<Kind, unknown[]>)[kind] = list
  }
  return next
}

/** The record a row belongs to — the Verlauf row's `suche` link. */
export function rowOwner(doc: SucheDoc, rowId: string): { personId?: string; bereichId?: string } | undefined {
  const p = doc.personen.find((x) => x.log.some((r) => r.id === rowId))
  if (p) return { personId: p.id }
  const b = doc.bereiche.find((x) => x.log.some((r) => r.id === rowId))
  return b ? { bereichId: b.id } : undefined
}

// ── which Trupp is on a storey ──────────────────────────────────────────────────────────────

export interface TruppHere {
  id: string
  /** «Trupp 3» — the paper name */
  label: string
  /** «T3 Muster» — the chip */
  short: string
}

/**
 * The Trupps a find / an area on this storey most likely belongs to, best first: the Trupp an
 * area on the storey is «in Arbeit» with, then the Trupps whose marker stands on the storey
 * (`placed`). «Gefunden…» pre-selects the first — the radio report came from somebody who is
 * there.
 */
export function truppsOnStorey(doc: SucheDoc, floor: number | undefined, trupps: readonly TruppHere[], placed: readonly { truppId: string; floor: number }[]): TruppHere[] {
  if (floor == null) return []
  const out: string[] = []
  for (const b of doc.bereiche.filter((x) => x.floor === floor)) {
    const st = bereichStatusOf(b)
    if (st.status === 'inArbeit' && st.truppId && !out.includes(st.truppId)) out.push(st.truppId)
  }
  for (const p of placed) if (p.floor === floor && !out.includes(p.truppId)) out.push(p.truppId)
  return out.map((id) => trupps.find((t) => t.id === id)).filter((t): t is TruppHere => !!t)
}

/** «Trupp 3» → «T3»: the compact form the list chips wear — the word's initial and the number,
 *  so it reads in any locale («Team 3» → «T3»); a label without a number stays as it is. */
export const truppShort = (label: string) => {
  const m = /^(\p{L})\p{L}*\s+(\d+)$/u.exec(label.trim())
  return m ? `${m[1].toUpperCase()}${m[2]}` : label
}

// ── the Verlauf composer (Tür 2) ────────────────────────────────────────────────────────────

/** …the same «must begin one of the target's words» rule the name and Pendenz suggestions use
 *  (lib/reminders · suggestPendenzen): a subsequence match hits almost anything from three
 *  letters on, and accepting one of these CHANGES a person's status. */
function startsAWord(word: string, target: string): boolean {
  return norm(target).split(/[\s(/,.+-]+/).some((w) => w.startsWith(word))
}

/** Named people still missing that the words being typed ARE — offered as «Eva Beispiel · vermisst
 *  → gefunden». EVERY typed word of ≥ 2 letters must start a word of the name: «eva bei» finds
 *  «Eva Beispiel», «eva» alone does too, but «eva im Keller» and «va» do not. */
export function suggestSuchePersonen(text: string, personen: readonly PersonView[], limit = 2): PersonView[] {
  const words = norm(text).split(/\s+/).filter((w) => w.length >= 2)
  if (!words.length) return []
  const C = appConfig.copy.suche
  return personen
    .filter((p) => p.status === 'vermisst' && p.label !== C.unnamed && p.label !== C.groupUnnamed)
    .filter((p) => words.every((w) => startsAWord(w, p.label)))
    .map((p) => ({ p, score: words.reduce((s, w) => s + fuzzyScore(w, p.label), 0) }))
    .sort((a, b) => b.score - a.score || a.p.firstAt.localeCompare(b.p.firstAt))
    .slice(0, limit)
    .map((m) => m.p)
}

/**
 * «Neue Person «Tim Muster» vermisst»: the sentence says «vermisst», and the NAME right before it
 * is the person — the trailing phrase only («Meldung Hauswart: Tim Muster vermisst» → «Tim
 * Muster»): after the last punctuation, at most the last two words that begin with a capital or a
 * digit («Klasse 3c»). Null when the word is not there or no such phrase precedes it.
 */
export function newPersonFromText(text: string): string | null {
  const kw = appConfig.copy.suche.composerKeyword
  const i = text.toLowerCase().indexOf(kw.toLowerCase())
  if (i <= 0) return null
  const tail = text.slice(0, i).split(/[:;,!?·–—]|\.\s/).pop() ?? ''
  const words = tail.trim().split(/\s+/).filter(Boolean)
  const run: string[] = []
  for (let k = words.length - 1; k >= 0 && run.length < 2; k--) {
    if (/^[\p{Lu}\d]/u.test(words[k])) run.unshift(words[k])
    else break
  }
  const name = run.join(' ').trim()
  return name && name.length <= 60 ? name : null
}

// ── the Rapport ─────────────────────────────────────────────────────────────────────────────

export interface PersonPrintRow {
  /** «Tim Muster», «Klasse 3c (22 Pers.)» */
  name: string
  /** «zuletzt 1. OG Technikraum · Quelle Hauswart» */
  detail?: string
  /** HH:MM reported missing — «–» for somebody found who was never reported */
  vermisst: string
  /** «20:16 · Trupp 3 · 1. OG Z101» (a group: «20 / 22 gefunden · 20:16 …») */
  gefunden?: string
  /** «20:21 an Rettungsdienst» · «entwarnt 20:05» · «vermisst» */
  status: string
  open: boolean
}

/**
 * One line per person with times, in the order things happened. A WITHDRAWN record
 * («irrtümlich erfasst») is not printed here at all: it was never a person, and the Einsatzjournal
 * above keeps both its rows for whoever needs the trail.
 */
export function personPrintRows(doc: SucheDoc | undefined, clock: (iso: string) => string, floorName: (f: number) => string): PersonPrintRow[] {
  if (!doc?.personen.length) return []
  const C = appConfig.copy.suche
  return doc.personen.map(personView)
    .filter((v) => v.status !== 'irrtuemlich')
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id))
    .map((v) => {
      const where = [v.floor != null ? floorName(v.floor) : '', v.wo ?? ''].filter(Boolean).join(' ')
      const detail = [v.vermisstAt && where ? fillTemplate(C.zuletztLine, { wo: where }) : '', v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '']
        .filter(Boolean).join(' · ')
      const foundWhere = [v.foundFloor != null ? floorName(v.foundFloor) : '', v.foundWo ?? ''].filter(Boolean).join(' ')
      const gefunden = v.foundAt
        ? [v.group ? fillTemplate(C.groupFound, { found: v.found, count: v.count }) : '', clock(v.foundAt), v.foundTrupp ?? '', foundWhere].filter(Boolean).join(' · ')
        : undefined
      const status = v.status === 'entwarnt' ? `${C.status.entwarnt} ${clock(v.entwarntAt!)}`
        : v.status === 'uebergeben' || (v.handed > 0 && v.an) ? `${clock(v.handedAt!)} ${C.an.toLowerCase()} ${v.an}`
        : v.status === 'gefunden' ? C.status.gefunden
        : v.group && v.found > 0 ? fillTemplate(C.groupMissing, { n: v.missing })
        : C.status.vermisst
      return {
        name: v.label + (v.group ? ` (${fillTemplate(C.groupPersons, { n: v.count })})` : ''),
        ...(detail ? { detail } : {}),
        vermisst: v.vermisstAt ? clock(v.vermisstAt) : '–',
        ...(gefunden ? { gefunden } : {}),
        status,
        open: v.missing > 0,
      }
    })
}

/** Was the Suche used at all — a person on the list, or an area somebody touched? */
const sucheUsed = (doc: SucheDoc) => doc.personen.length > 0 || doc.bereiche.some((b) => b.log.length > 0)

/**
 * «Suche: 8 Bereiche, alle abgesucht 20:39» — or what is still open. Null when the Suche was
 * never used (no person reported and no area touched): a line about eight untouched storeys on
 * the Rapport of a Kaminbrand would claim a search that never happened.
 */
export function sucheLine(doc: SucheDoc | undefined, groups: readonly SucheGroup[], clock: (iso: string) => string): string | null {
  if (!doc || !sucheUsed(doc)) return null
  const units = groups.flatMap((g) => g.units)
  if (!units.length) return null
  const C = appConfig.copy.suche
  const open = units.filter((u) => u.status !== 'abgesucht')
  if (!open.length) {
    const last = units.map((u) => u.statusAt).sort().pop() ?? ''
    return fillTemplate(C.suchLineAll, { n: units.length, t: last ? clock(last) : '' }).trim()
  }
  return fillTemplate(C.suchLineOpen, { n: units.length, done: units.length - open.length, list: open.map((u) => u.full).join(', ') })
}

/** The areas not yet abgesucht — the Abschluss's hint line. Only once the Suche was used. */
export function openBereiche(doc: SucheDoc | undefined, groups: readonly SucheGroup[]): string[] {
  if (!doc || !sucheUsed(doc)) return []
  return groups.flatMap((g) => g.units).filter((u) => u.status !== 'abgesucht').map((u) => u.full)
}

/** The Suche's one line — «Suche · 2 vermisst · Bereiche 5/8» — the phone sheet's peek. */
export function sucheSummary(missing: number, progress: { done: number; total: number }): string {
  const C = appConfig.copy.suche
  const vermisst = missing > 0 ? fillTemplate(C.peekVermisst, { n: missing }) : C.peekNobody
  return progress.total > 0
    ? fillTemplate(C.peek, { vermisst, done: progress.done, total: progress.total })
    : fillTemplate(C.peekNoBereiche, { vermisst })
}

/** What the tablet dock takes off the right of the surface beside it: its 340 px plus the 10 px
 *  channel (components/suche · Suche.module.css · .dock). The Gebäude fits itself into what is
 *  left (Whiteboard · dockInset). */
export const SUCHE_DOCK_INSET = 350

/** What an entry written in the Verlauf changes in the Suche on its way (Tür 2): a person still
 *  missing is found, or a new one is reported missing under the words before «vermisst». */
export type SucheComposerLink =
  | { kind: 'gefunden'; personId: string; label: string }
  | { kind: 'neu'; name: string }

/** The change in words, for the Verlauf row the entry becomes: «Tim Muster gefunden». */
export function sucheChangeWords(l: SucheComposerLink): string {
  const S = appConfig.copy.suche
  return l.kind === 'gefunden'
    ? fillTemplate(S.composerChangeGefunden, { name: l.label })
    : fillTemplate(S.composerChangeNeu, { name: l.name })
}

export function sucheLinkLabel(l: SucheComposerLink): string {
  const S = appConfig.copy.suche
  return l.kind === 'gefunden'
    ? fillTemplate(S.composerKnown, { name: l.label, from: S.status.vermisst, to: S.status.gefunden })
    : fillTemplate(S.composerNew, { name: l.name })
}
