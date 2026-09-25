// «Suche» — Personen + Bereiche (step 1, 24.09.2026). The pure half.
//
// Übung 23.09.2026: missing and found people lived in eleven free-text notes, the names spelt
// differently each time; «abgesucht» was drawn as red lines the app then offered to Trupps as
// their Leitung; and at 20:15 no screen could answer «wer fehlt noch, was ist abgesucht?».
//
// The model (types · SucheDoc) is ONE synced slice with two id-keyed lists. A record says WHO or
// WHERE; what happened to it is its own append-only `log`, and every state here is FOLDED from
// that log — never stored as a status field. So:
//   - two devices recording two things about one person keep both (the merge unions the log by
//     row id, mergeWorkspace · mergeSuche);
//   - replay shows the search as it stood at any moment for free (`sucheAt` drops later rows);
//   - the ↶ of a step is the slice's own snapshot undo, and the Verlauf says what was taken back
//     by quoting the row's own sentence (`movedRows`).
//
// Bereiche come into being by themselves: every storey of the Gebäude stack is one area
// «ganzes Geschoss» under a DERIVED id (`sbg<index>`), so two devices opening the Suche write the
// same record. A storey is split by NAMES (Trakt 3, Technikraum …) — the parts are rows under it,
// and the storey is abgesucht when all of them are. Nothing is drawn in step 1; `point`/`shape`
// are left empty for step 2.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { fuzzyScore, norm } from './quickPhrases'
import type { SucheBereich, SucheBereichStatus, SucheDoc, SuchePerson, SucheRow } from '../types'

export const emptySuche = (): SucheDoc => ({ personen: [], bereiche: [] })

/** The storey's own area: one id per storey index, the same on every device (AGENTS.md · derived
 *  ids). `sbg-1` is the 1. UG. */
export const storeyBereichId = (floor: number) => `sbg${floor}`
export const isStoreyRow = (b: Pick<SucheBereich, 'floor' | 'name'>) => b.floor != null && !b.name

/** What a write needs from the world: the shared clock, an id minter, and how a storey is named
 *  on this Gebäude (building.floorNames, else «1. OG»). */
export interface SucheCx {
  at: string
  newId: (prefix: string) => string
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
      const floor = int(p.floor)
      return {
        ...(p as unknown as SuchePerson),
        name: str(p.name),
        count: count != null && count >= 2 ? count : undefined,
        floor,
        createdAt: str(p.createdAt) ?? '',
        log: sanitizeRows(p.log),
      }
    })
  const bereiche = (Array.isArray(raw.bereiche) ? raw.bereiche : [])
    .filter((b): b is Record<string, unknown> & { id: string } => isObj(b) && typeof b.id === 'string')
    .map((b): SucheBereich => ({
      ...(b as unknown as SucheBereich),
      floor: int(b.floor),
      name: str(b.name),
      createdAt: str(b.createdAt) ?? '',
      log: sanitizeRows(b.log),
    }))
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

export type PersonStatus = 'vermisst' | 'gefunden' | 'uebergeben' | 'entwarnt'

export interface PersonView {
  id: string
  /** the name as written, else «Person ohne Namen» / «Gruppe ohne Namen» */
  label: string
  group: boolean
  /** how many people the record stands for (1 for a single person) */
  count: number
  /** people found (gefunden or übergeben) */
  found: number
  /** people handed over */
  handed: number
  /** people still missing — 0 once found or entwarnt */
  missing: number
  status: PersonStatus
  /** when it was reported missing (the first `vermisst` row, else the record's creation) */
  vermisstAt: string
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
  rows: SucheRow[]
}

export function personLabel(p: Pick<SuchePerson, 'name' | 'count'>): string {
  const C = appConfig.copy.suche
  return p.name?.trim() || (p.count ? C.groupUnnamed : C.unnamed)
}

/**
 * Fold one person's log into what the list, the head chip and the Rapport read.
 *
 * A single person is whatever its latest row says. A GROUP counts: every `gefunden` row adds its
 * `n` (capped at the group's size), every `übergeben` row likewise, and the group is «gefunden»
 * only when all of it is — «20 / 22 gefunden» is still two people missing, and the head chip says
 * so. `entwarnt` stands for the whole record (nobody was inside after all).
 */
export function personView(p: SuchePerson): PersonView {
  const count = p.count && p.count >= 2 ? p.count : 1
  const group = count >= 2
  let found = 0
  let handed = 0
  let entwarnt: string | undefined
  let vermisstAt: string | undefined
  const v: Partial<PersonView> = {}
  for (const r of chrono(p.log)) {
    if (r.op === 'vermisst') {
      vermisstAt ??= r.at
      // re-reported missing (a single person only): the earlier find no longer stands
      if (!group) { found = 0; handed = 0; entwarnt = undefined }
    } else if (r.op === 'gefunden') {
      found = Math.min(count, found + (group ? Math.max(1, r.n ?? 1) : 1))
      entwarnt = undefined
      Object.assign(v, { foundAt: r.at, foundTrupp: r.trupp, foundTruppId: r.truppId, foundFloor: r.floor, foundWo: r.wo })
    } else if (r.op === 'uebergeben') {
      const n = group ? Math.max(1, r.n ?? 1) : 1
      handed = Math.min(count, handed + n)
      // a handover of somebody nobody booked as found still found them
      found = Math.max(found, handed)
      Object.assign(v, { handedAt: r.at, an: r.an })
    } else if (r.op === 'entwarnt') {
      entwarnt = r.at
    }
  }
  const status: PersonStatus = entwarnt ? 'entwarnt'
    : found >= count ? (handed >= count ? 'uebergeben' : 'gefunden')
    : 'vermisst'
  return {
    ...v,
    id: p.id,
    label: personLabel(p),
    group,
    count,
    found: entwarnt ? 0 : found,
    handed: entwarnt ? 0 : handed,
    missing: entwarnt ? 0 : count - found,
    status,
    vermisstAt: vermisstAt ?? p.createdAt,
    floor: p.floor,
    wo: p.wo?.trim() || undefined,
    quelle: p.quelle?.trim() || undefined,
    entwarntAt: entwarnt,
    rows: chrono(p.log),
  }
}

/** Order for the list: still missing first (longest missing on top — the position carries the
 *  age), then found, handed over, and entwarnt last. */
const STATUS_ORDER: Record<PersonStatus, number> = { vermisst: 0, gefunden: 1, uebergeben: 2, entwarnt: 3 }
export function personenViews(doc: SucheDoc): PersonView[] {
  return doc.personen.map(personView).sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || a.vermisstAt.localeCompare(b.vermisstAt)
    || a.id.localeCompare(b.id))
}

/** People still missing, across the whole list — the head chip, the rail badge, the Abschluss. */
export function vermisstCount(doc: SucheDoc | undefined): number {
  if (!doc) return 0
  return doc.personen.reduce((n, p) => n + personView(p).missing, 0)
}

/** «Gerettete» counted from the list: everybody found or handed over, a group by its count.
 *  An entwarnt record was never inside and rescues nobody. */
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

export function bereichStatusOf(b: SucheBereich): { status: SucheBereichStatus; trupp?: string; truppId?: string; at: string; fund: boolean } {
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
  return { status, trupp, truppId, at, fund }
}

/** Does this storey have named parts (so its own row is the «übriges Geschoss»)? */
const partsOf = (doc: SucheDoc, floor: number) => doc.bereiche.filter((b) => b.floor === floor && !!b.name)

export function bereichView(doc: SucheDoc, b: SucheBereich, floorName: (f: number) => string, virtual = false): BereichView {
  const C = appConfig.copy.suche
  const st = bereichStatusOf(b)
  const storey = isStoreyRow(b)
  const split = storey && partsOf(doc, b.floor!).length > 0
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
  /** the storey's own record id (`sbg<index>`), null for the no-storey group */
  storeyId: string | null
  /** the areas that COUNT — the storey row leaves the list once its parts cover it (`ohneRest`) */
  units: BereichView[]
  /** the storey row even when it is not a unit (for «übriges Geschoss wieder aufnehmen») */
  storeyRow?: BereichView
  hasParts: boolean
  done: number
  total: number
  complete: boolean
}

/**
 * The Bereiche as the list shows them: one group per storey, TOP to bottom like the stack, then
 * the areas without a storey. `floors` is the Gebäude stack as it stands; a storey that has
 * records but is no longer on the stack still shows (its record is not ours to hide).
 *
 * A storey nobody has seeded yet appears as a VIRTUAL «ganzes Geschoss · offen» — so a device
 * that may not write (the `el`, a viewer) sees the same gaps an editor does, and the first write
 * saves it under the id every device would have given it.
 */
export function sucheGroups(doc: SucheDoc, floors: readonly number[], floorName: (f: number) => string): SucheGroup[] {
  const C = appConfig.copy.suche
  const storeys = [...new Set([...floors, ...doc.bereiche.filter((b) => b.floor != null).map((b) => b.floor!)])]
    .sort((a, b) => b - a)
  const groups: SucheGroup[] = storeys.map((f) => {
    const own = doc.bereiche.find((b) => b.id === storeyBereichId(f)) ?? doc.bereiche.find((b) => b.floor === f && !b.name)
    const storeyRec: SucheBereich = own ?? { id: storeyBereichId(f), floor: f, createdAt: '', log: [] }
    const storeyRow = bereichView(doc, storeyRec, floorName, !own)
    const parts = doc.bereiche.filter((b) => b.floor === f && !!b.name && b.id !== storeyRec.id)
      .map((b) => bereichView(doc, b, floorName))
    const units = [...parts, ...(parts.length && storeyRec.ohneRest ? [] : [storeyRow])]
    const done = units.filter((u) => u.status === 'abgesucht').length
    return {
      key: `f${f}`, floor: f, label: floorName(f), storeyId: storeyRec.id,
      units, storeyRow, hasParts: parts.length > 0,
      done, total: units.length, complete: units.length > 0 && done === units.length,
    }
  })
  const loose = doc.bereiche.filter((b) => b.floor == null).map((b) => bereichView(doc, b, floorName))
  if (loose.length) {
    const done = loose.filter((u) => u.status === 'abgesucht').length
    groups.push({ key: 'none', floor: null, label: C.ohneGeschoss, storeyId: null, units: loose, hasParts: false, done, total: loose.length, complete: done === loose.length })
  }
  return groups
}

export function sucheProgress(groups: readonly SucheGroup[]): { done: number; total: number } {
  return groups.reduce((a, g) => ({ done: a.done + g.done, total: a.total + g.total }), { done: 0, total: 0 })
}

/** The storey's progress as its label on the stack carries it: «2/4», or null when the storey
 *  has no area yet. */
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

// ── writes: each returns the NEW doc (or the same object when nothing changed) + the row ────

/** Seed one «ganzes Geschoss» per storey of the stack. IDEMPOTENT by construction — the same
 *  doc comes back when every storey already has its row, so a caller that runs this on open can
 *  never lay a step or a save for nothing (AGENTS.md · a machine writer is idempotent). */
export function ensureStoreyBereiche(doc: SucheDoc, floors: readonly number[], at: string): SucheDoc {
  const have = new Set(doc.bereiche.filter((b) => isStoreyRow(b)).map((b) => b.floor))
  const add = [...new Set(floors)].filter((f) => !have.has(f))
    .map((f): SucheBereich => ({ id: storeyBereichId(f), floor: f, createdAt: at, log: [] }))
  return add.length ? { ...doc, bereiche: [...doc.bereiche, ...add] } : doc
}

/** A storey's row, created (under its derived id) when a write reaches a virtual one. */
function withStorey(doc: SucheDoc, floor: number, at: string): SucheDoc {
  return ensureStoreyBereiche(doc, [floor], at)
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

/** «Vermisst: Tim Muster (22 Pers.) · zuletzt 1. OG Technikraum · Quelle Schulleitung» */
export function vermisstText(p: VermisstInput, floorName: (f: number) => string): string {
  const C = appConfig.copy.suche
  const name = personLabel({ name: p.name, count: p.count }) + (p.count && p.count >= 2 ? ` (${fillTemplate(C.groupPersons, { n: p.count })})` : '')
  const where = [p.floor != null ? floorName(p.floor) : '', p.wo?.trim() ?? ''].filter(Boolean).join(' ')
  return fillTemplate(C.rowVermisst, { name })
    + seg(C.rowZuletzt, { wo: where }, where)
    + seg(C.rowQuelle, { quelle: p.quelle?.trim() ?? '' }, p.quelle?.trim())
}

export function addPerson(doc: SucheDoc, input: VermisstInput, cx: SucheCx): { doc: SucheDoc; person: SuchePerson; row: SucheRow } {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const clean = (s?: string) => s?.trim() || undefined
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'vermisst', text: vermisstText({ ...input, count }, cx.floorName) }
  const person: SuchePerson = {
    id: cx.newId('sp'),
    ...(clean(input.name) ? { name: clean(input.name) } : {}),
    ...(count ? { count } : {}),
    ...(input.floor != null ? { floor: input.floor } : {}),
    ...(clean(input.wo) ? { wo: clean(input.wo) } : {}),
    ...(clean(input.quelle) ? { quelle: clean(input.quelle) } : {}),
    createdAt: cx.at,
    log: [row],
  }
  return { doc: { ...doc, personen: [...doc.personen, person] }, person, row }
}

export interface GefundenInput {
  /** how many of a group (ignored for a single person) */
  n?: number
  trupp?: string
  truppId?: string
  floor?: number
  wo?: string
  /** optional handover in the same breath («weiter an») */
  an?: string
}

/**
 * «Gefunden: Tim Muster · 1. OG Technikraum · Trupp 3». A find on a storey also marks that
 * storey's area «Fund» (the part named by `wo` when there is one, else the storey), so the
 * Bereiche tab shows where people were found without anybody reporting it twice.
 */
export function personGefunden(doc: SucheDoc, personId: string, input: GefundenInput, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const view = personView(p)
  const n = view.group ? Math.max(1, Math.min(view.count - view.found, Math.round(input.n ?? (view.count - view.found)))) : undefined
  const where = [input.floor != null ? cx.floorName(input.floor) : '', input.wo?.trim() ?? ''].filter(Boolean).join(' ')
  const text = (view.group ? fillTemplate(C.rowGefundenGroup, { n: n ?? 1, name: view.label }) : fillTemplate(C.rowGefunden, { name: view.label }))
    + seg(C.rowWo, { wo: where }, where)
    + seg(C.rowTrupp, { trupp: input.trupp ?? '' }, input.trupp)
  const row: SucheRow = {
    id: cx.newId('sr'), at: cx.at, op: 'gefunden', text,
    ...(n != null ? { n } : {}),
    ...(input.trupp ? { trupp: input.trupp } : {}),
    ...(input.truppId ? { truppId: input.truppId } : {}),
    ...(input.floor != null ? { floor: input.floor } : {}),
    ...(input.wo?.trim() ? { wo: input.wo.trim() } : {}),
  }
  let next: SucheDoc = { ...doc, personen: appendRow(doc.personen, personId, row) }
  const rows = [row]
  if (input.an?.trim()) {
    const h = personUebergeben(next, personId, { an: input.an, n }, cx)
    next = h.doc
    rows.push(...h.rows)
  }
  if (input.floor != null) {
    const t = fundTarget(next, input.floor, input.wo, cx.at)
    const f = markFund(t.doc, t.id, personId, cx)
    next = f.doc
    rows.push(...f.rows)
  }
  return { doc: next, rows }
}

/** Which area a find on this storey belongs to: a part whose name the place starts with
 *  («Technikraum» → «Technik…»), else the storey itself. Seeds the storey row when needed. */
function fundTarget(doc: SucheDoc, floor: number, wo: string | undefined, at: string): { doc: SucheDoc; id: string } {
  const w = norm(wo ?? '')
  const part = w ? doc.bereiche.find((b) => b.floor === floor && !!b.name && (w.startsWith(norm(b.name!)) || norm(b.name!).startsWith(w))) : undefined
  if (part) return { doc, id: part.id }
  return { doc: withStorey(doc, floor, at), id: storeyBereichId(floor) }
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
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'entwarnt', text: fillTemplate(appConfig.copy.suche.rowEntwarnt, { name: personLabel(p) }) }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** The row a Bereich write appends to, seeding a virtual storey row first. */
function bereichFor(doc: SucheDoc, id: string, at: string): { doc: SucheDoc; b?: SucheBereich } {
  const m = /^sbg(-?\d+)$/.exec(id)
  const seeded = m && !doc.bereiche.some((b) => b.id === id) ? withStorey(doc, Number(m[1]), at) : doc
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
  if (cur.status === status && cur.trupp === label) return { doc, rows: [] }
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

/** «Fund: 1. OG Technikraum · Tim Muster» — the area where somebody was found. A storey that
 *  is still virtual is seeded under its derived id first. */
export function markFund(doc: SucheDoc, id: string, personId: string | undefined, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const { doc: seeded, b } = bereichFor(doc, id, cx.at)
  if (!b) return { doc, rows: [] }
  const view = bereichView(seeded, b, cx.floorName)
  const person = personId ? seeded.personen.find((p) => p.id === personId) : undefined
  const text = person ? fillTemplate(C.rowFundPerson, { bereich: view.full, name: personLabel(person) }) : fillTemplate(C.rowFund, { bereich: view.full })
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'fund', text, ...(personId ? { personId } : {}) }
  return { doc: { ...seeded, bereiche: appendRow(seeded.bereiche, id, row) }, rows: [row] }
}

/**
 * Split a storey by NAMES: each new name becomes a part under it; a name the storey already has
 * is skipped (case and spacing do not make a second «Trakt 3»). `keepRest: false` says the parts
 * cover the whole storey. The storey row carries the one «geteilt» row, so the step is one row.
 */
export function splitStorey(doc: SucheDoc, floor: number, names: readonly string[], keepRest: boolean, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; created: SucheBereich[] } {
  const C = appConfig.copy.suche
  let d = withStorey(doc, floor, cx.at)
  const have = new Set(partsOf(d, floor).map((b) => norm(b.name!)))
  const created: SucheBereich[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name || have.has(norm(name))) continue
    have.add(norm(name))
    created.push({ id: cx.newId('sb'), floor, name, createdAt: cx.at, log: [] })
  }
  const sid = storeyBereichId(floor)
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

/** «übriges Geschoss» out of / back into the count, on its own (the storey's row menu). */
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
 *  name on the same storey is found, not duplicated. */
export function addBereich(doc: SucheDoc, input: { name: string; floor?: number }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; id: string | null } {
  const name = input.name.trim()
  if (!name) return { doc, rows: [], id: null }
  const found = findBereichByName(doc, name, input.floor, cx.floorName)
  if (found) return { doc, rows: [], id: found }
  if (input.floor != null) {
    const r = splitStorey(doc, input.floor, [name], true, cx)
    return { doc: r.doc, rows: r.rows, id: r.created[0]?.id ?? null }
  }
  const b: SucheBereich = { id: cx.newId('sb'), name, createdAt: cx.at, log: [] }
  return { doc: { ...doc, bereiche: [...doc.bereiche, b] }, rows: [], id: b.id }
}

/**
 * The area a typed name means — a Trupp's Ziel («Trakt 3», «1. OG», «EG Trakt 3», «Aula»).
 * A storey's own label (with or without «ganzes Geschoss») is that storey's row; «<storey>
 * <part>» or a bare part name on the given storey is that part. Null when nothing matches.
 */
export function findBereichByName(doc: SucheDoc, text: string, floor: number | undefined, floorName: (f: number) => string): string | null {
  const t = norm(text)
  if (!t) return null
  const storeys = [...new Set(doc.bereiche.filter((b) => b.floor != null).map((b) => b.floor!))]
  for (const f of storeys) {
    const fl = norm(floorName(f))
    if (t === fl || t === `${fl} ${norm(appConfig.copy.suche.ganzesGeschoss)}`) return storeyBereichId(f)
    for (const b of partsOf(doc, f)) {
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

// ── undo: what a step took back ─────────────────────────────────────────────────────────────

/** Every row in `a` that is not in `b` — a ↶ from `a` to `b` took these back, a ↷ from `b` to
 *  `a` put them back. The Verlauf quotes each one's own sentence. */
export function movedRows(a: SucheDoc, b: SucheDoc): SucheRow[] {
  const inB = new Set([...b.personen, ...b.bereiche].flatMap((x) => x.log.map((r) => r.id)))
  return [...a.personen, ...a.bereiche].flatMap((x) => x.log).filter((r) => !inB.has(r.id))
    .sort((x, y) => x.at.localeCompare(y.at))
}

/** The record a row belongs to — the Verlauf row's `suche` link. */
export function rowOwner(doc: SucheDoc, rowId: string): { personId?: string; bereichId?: string } | undefined {
  const p = doc.personen.find((x) => x.log.some((r) => r.id === rowId))
  if (p) return { personId: p.id }
  const b = doc.bereiche.find((x) => x.log.some((r) => r.id === rowId))
  return b ? { bereichId: b.id } : undefined
}

// ── replay ──────────────────────────────────────────────────────────────────────────────────

/** The search as it stood at `tMs`: records created later are gone, rows written later are
 *  dropped. The snapshot anchor carries the slice; this makes the fold exact between saves. */
export function sucheAt(doc: SucheDoc | undefined, tMs: number): SucheDoc {
  if (!doc) return emptySuche()
  const before = (iso: string) => !iso || !Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= tMs
  const cut = <T extends { createdAt: string; log: SucheRow[] }>(x: T): T | null =>
    (before(x.createdAt) ? { ...x, log: x.log.filter((r) => before(r.at)) } : null)
  return {
    personen: doc.personen.map(cut).filter((x): x is SuchePerson => !!x),
    bereiche: doc.bereiche.map(cut).filter((x): x is SucheBereich => !!x),
  }
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

/** Named people the sentence being typed talks about, still missing — offered as «Eva Beispiel ·
 *  vermisst → gefunden». Every typed word of ≥ 2 letters must start a word of the name, so
 *  «emma sch» finds «Eva Beispiel» and «emma» alone does too, but «ma» does not. */
export function suggestSuchePersonen(text: string, personen: readonly PersonView[], limit = 2): PersonView[] {
  const words = norm(text).split(/\s+/).filter((w) => w.length >= 2)
  if (!words.length) return []
  return personen
    .filter((p) => p.status === 'vermisst' && !!p.label && p.label !== appConfig.copy.suche.unnamed && p.label !== appConfig.copy.suche.groupUnnamed)
    .map((p) => {
      const hits = words.filter((w) => startsAWord(w, p.label))
      return { p, score: hits.length ? hits.reduce((s, w) => s + fuzzyScore(w, p.label), 0) : 0 }
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.p.vermisstAt.localeCompare(b.p.vermisstAt))
    .slice(0, limit)
    .map((m) => m.p)
}

/** «Neue Person «emma sch…» vermisst»: the sentence says «vermisst», and the words before it
 *  are the name. Null when the word is not there or nothing precedes it. */
export function newPersonFromText(text: string): string | null {
  const kw = appConfig.copy.suche.composerKeyword
  const i = text.toLowerCase().indexOf(kw.toLowerCase())
  if (i < 0) return null
  const name = text.slice(0, i).replace(/[\s,;:·–-]+$/u, '').replace(/^[\s,;:·–-]+/u, '').trim()
  if (!name || name.length > 60) return null
  return name
}

// ── the Rapport ─────────────────────────────────────────────────────────────────────────────

export interface PersonPrintRow {
  /** «Tim Muster», «Klasse 3c (22 Pers.)» */
  name: string
  /** «zuletzt 1. OG Technikraum · Quelle Schulleitung» */
  detail?: string
  /** HH:MM reported missing */
  vermisst: string
  /** «20:16 · Trupp 3 · 1. OG Z301» (a group: «20 / 22 · 20:16 …») */
  gefunden?: string
  /** «20:21 an Rettungsdienst» · «entwarnt 20:05» · «noch vermisst» */
  status: string
  open: boolean
}

/** One line per person with times, in the order they were reported. */
export function personPrintRows(doc: SucheDoc | undefined, clock: (iso: string) => string, floorName: (f: number) => string): PersonPrintRow[] {
  if (!doc?.personen.length) return []
  const C = appConfig.copy.suche
  return doc.personen.map(personView)
    .sort((a, b) => a.vermisstAt.localeCompare(b.vermisstAt) || a.id.localeCompare(b.id))
    .map((v) => {
      const where = [v.floor != null ? floorName(v.floor) : '', v.wo ?? ''].filter(Boolean).join(' ')
      const detail = [where ? fillTemplate(C.zuletztLine, { wo: where }) : '', v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '']
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
        vermisst: clock(v.vermisstAt),
        ...(gefunden ? { gefunden } : {}),
        status,
        open: v.missing > 0,
      }
    })
}

/**
 * «Suche: 8 Bereiche, alle abgesucht 20:39» — or what is still open. Null when the Suche was
 * never used (no person reported and no area touched): a line about eight untouched storeys on
 * the Rapport of a Kaminbrand would claim a search that never happened.
 */
export function sucheLine(doc: SucheDoc | undefined, groups: readonly SucheGroup[], clock: (iso: string) => string): string | null {
  if (!doc) return null
  const touched = doc.personen.length > 0 || doc.bereiche.some((b) => b.log.length > 0)
  if (!touched) return null
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

/** The areas not yet abgesucht — the Abschluss's hint line («Trakt 3 nicht abgesucht»). Only
 *  once the Suche was used, for the same reason as `sucheLine`. */
export function openBereiche(doc: SucheDoc | undefined, groups: readonly SucheGroup[]): string[] {
  if (!doc || !(doc.personen.length > 0 || doc.bereiche.some((b) => b.log.length > 0))) return []
  return groups.flatMap((g) => g.units).filter((u) => u.status !== 'abgesucht').map((u) => u.full)
}

/** The slice's undo keeps what the MACHINE seeded after the checkpoint: a storey row with no
 *  rows of its own is nobody's step, and handing it back would only have the next open write it
 *  again (useUndoableSlice · onRestore). */
export function keepSucheSeeds(to: SucheDoc, live: SucheDoc): SucheDoc {
  const have = new Set(to.bereiche.map((b) => b.id))
  const seeds = live.bereiche.filter((b) => isStoreyRow(b) && b.log.length === 0 && !have.has(b.id))
  return seeds.length ? { ...to, bereiche: [...to.bereiche, ...seeds] } : to
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
