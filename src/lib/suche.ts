// «Suche» — Personen + Orte (step 1 24.09.2026, reworked 26.09.2026). The pure half.
//
// Übung 23.09.2026: missing and found people lived in free-text notes, the names spelt
// differently each time; «abgesucht» was drawn as red lines the app then offered to Trupps as
// their Leitung; and at 20:15 no screen could answer «wer fehlt noch, was ist abgesucht?».
//
// The model (types · SucheDoc) is ONE synced slice with two id-keyed lists. A record says WHO or
// WHERE; what happened to it is its own append-only `log`, and every state here is FOLDED from
// that log — never stored as a status field. So:
//   - two devices recording two things about one person keep both (the merge unions the log by
//     row id, mergeWorkspace · mergeSuche);
//   - a correction is a row too (`korrigiert`, `irrtuemlich`), folded like the statuses;
//   - the ↶ of a step removes exactly what that step added (`diffSuche` / `applySuchePatch`), so a
//     row another device or the machine wrote in between is never taken back with it;
//   - replay folds the same patches forward from the audit events (lib/replay · `suche.step`).
//
// ⚠️ NOTHING IS PRESET (owner, 26.09.2026, design «F»). Step 1 made every storey of the Gebäude
// an area of its own on the first open («ganzes Geschoss»), and the list opened on eight rows
// nobody had asked for. A place («Ort») is now whatever somebody TYPED — «Keller», «Wohnung 2. OG
// links», «Scheune» — and the list is empty until somebody enters something. The same list serves
// a search for named people and a plain sweep with nobody missing at all. People stand under the
// place they were last seen at (`SuchePerson.bereichId`, else the words), so «T1 sucht» and
// «Muster Tim» are one line apart. Records step 1 wrote (a storey `floor`, a derived `sbg:` id)
// still load and read as «1. OG» / «1. OG Trakt 3»; a storey row the machine seeded and nobody
// ever touched is not shown — it was never somebody's entry.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { fuzzyScore, norm } from './quickPhrases'
import type { Entity, LayerId, SucheBereich, SucheBereichStatus, SucheDoc, SuchePerson, SuchePoint, SucheRow } from '../types'

export const emptySuche = (): SucheDoc => ({ personen: [], bereiche: [] })

/** What a write needs from the world: the shared clock, an id minter, and how a step-1 storey is
 *  named on this Gebäude (building.floorNames, else «1. OG») — only old records carry one. */
export interface SucheCx {
  at: string
  newId: (prefix: string) => string
  floorName: (floor: number) => string
}

/** How the Suche names the storey an OLD record (step 1) carries — nothing else of the Gebäude
 *  is read any more (the owner's F-d: places are not tied to storeys). */
export interface SucheStack {
  floorName: (floor: number) => string
}

// ── the load gate ───────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function sanitizeRows(v: unknown): SucheRow[] {
  if (!Array.isArray(v)) return []
  return v.filter((r): r is SucheRow => isObj(r) && typeof r.id === 'string' && typeof r.op === 'string')
    .map((r) => ({ ...r, at: str(r.at) ?? '', text: str(r.text) ?? '' }))
}

/** A position as the load gate hands it on: a Karte coord that is two finite numbers, or a sheet
 *  position with finite x/y — anything else is dropped rather than drawn at NaN. */
function sanitizePoint(v: unknown): SuchePoint | undefined {
  if (!isObj(v)) return undefined
  const c = Array.isArray(v.coord) && v.coord.length === 2 && v.coord.every((n) => num(n) != null) ? v.coord as [number, number] : undefined
  const x = num(v.x)
  const y = num(v.y)
  const sheet = str(v.planId) && x != null && y != null
  if (!c && !sheet) return undefined
  return {
    ...(c ? { coord: [c[0], c[1]] } : {}),
    ...(sheet ? { planId: str(v.planId), x, y, ...(int(v.floor) != null ? { floor: int(v.floor) } : {}) } : {}),
  }
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
      const point = sanitizePoint(p.point)
      const { name: _n, count: _c, floor: _f, bereichId: _b, point: _p, ...rest } = p as unknown as SuchePerson
      void _n; void _c; void _f; void _b; void _p
      return {
        ...rest,
        ...(str(p.name) ? { name: str(p.name) } : {}),
        ...(count != null && count >= 2 ? { count } : {}),
        ...(int(p.floor) != null ? { floor: int(p.floor) } : {}),
        ...(str(p.bereichId) ? { bereichId: str(p.bereichId) } : {}),
        ...(point ? { point } : {}),
        createdAt: str(p.createdAt) ?? '',
        log: sanitizeRows(p.log),
      }
    })
  const bereiche = (Array.isArray(raw.bereiche) ? raw.bereiche : [])
    .filter((b): b is Record<string, unknown> & { id: string } => isObj(b) && typeof b.id === 'string')
    .map((b): SucheBereich => {
      const point = sanitizePoint(b.point)
      const { floor: _f, name: _n, point: _p, ...rest } = b as unknown as SucheBereich
      void _f; void _n; void _p
      return {
        ...rest,
        ...(int(b.floor) != null ? { floor: int(b.floor) } : {}),
        ...(str(b.name) ? { name: str(b.name) } : {}),
        ...(point ? { point } : {}),
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
  /** zuletzt gesehen: a step-1 storey (old records only) and the words */
  floor?: number
  wo?: string
  /** zuletzt gesehen, as the place on the list the person was reported at (types · SuchePerson) */
  bereichId?: string
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

type Fixed = Pick<SuchePerson, 'name' | 'count' | 'floor' | 'wo' | 'bereichId'>

/** The record as its `korrigiert` rows leave it — name, count and «zuletzt gesehen». */
function corrected(p: SuchePerson): Fixed {
  const out: Fixed = { name: p.name, count: p.count, floor: p.floor, wo: p.wo, bereichId: p.bereichId }
  for (const r of chrono(p.log)) {
    if (r.op !== 'korrigiert' || !r.set) continue
    if ('name' in r.set) out.name = r.set.name?.trim() || undefined
    if ('count' in r.set) out.count = r.set.count && r.set.count >= 2 ? r.set.count : undefined
    if ('floor' in r.set) out.floor = r.set.floor ?? undefined
    if ('wo' in r.set) out.wo = r.set.wo?.trim() || undefined
    if ('bereichId' in r.set) out.bereichId = r.set.bereichId ?? undefined
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
    } else if (r.op === 'korrigiert' && r.set) {
      // where the person was FOUND, corrected (walk-through 25.09.2026): the latest find's place
      if ('foundFloor' in r.set) v.foundFloor = r.set.foundFloor ?? undefined
      if ('foundWo' in r.set) v.foundWo = r.set.foundWo?.trim() || undefined
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
    bereichId: fix.bereichId,
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

// ── Orte: the places on the list ────────────────────────────────────────────────────────────

export interface BereichView {
  id: string
  /** what the list, the Verlauf and the Rapport call it: «Keller» — or, for a step-1 record,
   *  «1. OG» / «1. OG Trakt 3» */
  label: string
  /** the typed name — absent on a step-1 storey row, which has none (and cannot be renamed) */
  name?: string
  /** a step-1 storey (old records only) */
  floor?: number
  status: SucheBereichStatus
  /** who searches / searched it, as the row said it («Trupp 4») */
  trupp?: string
  truppId?: string
  /** when the current status was set ('' for the implicit «offen») */
  statusAt: string
  fund: boolean
  /** where it stands on the Karte or a plan, when somebody put it there */
  point?: SuchePoint
  createdAt: string
  rows: SucheRow[]
}

export const BEREICH_STATUSES: readonly SucheBereichStatus[] = ['offen', 'inArbeit', 'teilweise', 'abgesucht', 'nichtZugaenglich']

/** The area's status, folded from its rows. `doc` adds the finds booked on PEOPLE: a `gefunden`
 *  row names the area it happened in, and that is what makes the area wear «Fund». */
export function bereichStatusOf(b: SucheBereich, doc?: SucheDoc): { status: SucheBereichStatus; trupp?: string; truppId?: string; at: string; fund: boolean } {
  let status: SucheBereichStatus = 'offen'
  let trupp: string | undefined
  let truppId: string | undefined
  let at = ''
  let fund = false
  for (const r of chrono(b.log)) {
    // a status this build does not know (a newer one wrote it) is skipped, never shown as «undefined»
    if (r.op === 'status' && r.status && BEREICH_STATUSES.includes(r.status)) {
      status = r.status
      at = r.at
      // «in Arbeit · T4», «teilweise · T4» and «abgesucht · T4» keep their Trupp; «offen» clears it
      trupp = r.status === 'offen' ? undefined : r.trupp
      truppId = r.status === 'offen' ? undefined : r.truppId
    } else if (r.op === 'fund') fund = true
  }
  if (!fund && doc) fund = doc.personen.some((p) => foundBereiche(p).includes(b.id))
  return { status, trupp, truppId, at, fund }
}

/**
 * The areas a person's finds happened in — what makes an area wear «Fund». A corrected found place
 * (`korrigiert` · `set.foundBereichId`) moves the LATEST find; a withdrawn record marks nothing.
 */
export function foundBereiche(p: SuchePerson): string[] {
  const rows = chrono(p.log)
  if (rows.some((r) => r.op === 'irrtuemlich')) return []
  const out: (string | undefined)[] = []
  for (const r of rows) {
    if (r.op === 'gefunden') out.push(r.bereichId)
    else if (r.op === 'korrigiert' && r.set && 'foundBereichId' in r.set && out.length) out[out.length - 1] = r.set.foundBereichId ?? undefined
  }
  return out.filter((x): x is string => !!x)
}

/** A step-1 storey's own row («ganzes Geschoss»): a storey and no name. */
export const isStoreyRow = (b: Pick<SucheBereich, 'floor' | 'name'>) => b.floor != null && !b.name

/** The place's name as everything reads it. A step-1 record says its storey too. */
export function placeLabel(b: Pick<SucheBereich, 'floor' | 'name'>, floorName: (f: number) => string): string {
  if (b.floor == null) return b.name?.trim() ?? ''
  return b.name ? fillTemplate(appConfig.copy.suche.rowPart, { floor: floorName(b.floor), name: b.name }) : floorName(b.floor)
}

/** Two spellings of one place are one place: case, accents and spacing do not make a second
 *  «Keller» (the same folding the name suggestions use). */
export const placeKey = (text: string) => norm(text.trim().replace(/\s+/g, ' '))

/** The place a typed text means — by its label, as the list shows it. */
export function findPlace(doc: SucheDoc, text: string, floorName: (f: number) => string): string | null {
  const k = placeKey(text)
  if (!k) return null
  return doc.bereiche.find((b) => placeKey(placeLabel(b, floorName)) === k)?.id ?? null
}

/** The place a typed text means, CREATED when it is new — no row of its own: the act it is part of
 *  («Vermisst: … · zuletzt Keller») already says it, and its ↶ takes the place back with it. */
export function ensurePlace(doc: SucheDoc, text: string, cx: SucheCx): { doc: SucheDoc; id: string | null } {
  const name = text.trim().replace(/\s+/g, ' ')
  if (!name) return { doc, id: null }
  const hit = findPlace(doc, name, cx.floorName)
  if (hit) return { doc, id: hit }
  const b: SucheBereich = { id: cx.newId('sb'), name, createdAt: cx.at, log: [] }
  return { doc: { ...doc, bereiche: [...doc.bereiche, b] }, id: b.id }
}

export function bereichView(doc: SucheDoc, b: SucheBereich, floorName: (f: number) => string): BereichView {
  const st = bereichStatusOf(b, doc)
  return {
    id: b.id, label: placeLabel(b, floorName), name: b.name, floor: b.floor,
    status: st.status, trupp: st.trupp, truppId: st.truppId, statusAt: st.at, fund: st.fund,
    ...(b.point ? { point: b.point } : {}),
    createdAt: b.createdAt, rows: chrono(b.log),
  }
}

/** «zuletzt 1. OG Technikraum» — a step-1 storey and the words, as one text */
const whereText = (floor: number | undefined, wo: string | undefined, floorName: (f: number) => string) =>
  [floor != null ? floorName(floor) : '', wo?.trim() ?? ''].filter(Boolean).join(' ')

/**
 * The place a person was last seen at: the one the report pointed at (`bereichId`, kept through a
 * rename), else the place whose label IS the words (records the composer or step 1 wrote), else —
 * a step-1 storey — the part the words begin, or the storey's own row.
 */
export function personPlace(doc: SucheDoc, v: Pick<PersonView, 'bereichId' | 'floor' | 'wo'>, floorName: (f: number) => string): string | null {
  if (v.bereichId && doc.bereiche.some((b) => b.id === v.bereichId)) return v.bereichId
  const hit = findPlace(doc, whereText(v.floor, v.wo, floorName), floorName)
  if (hit || v.floor == null) return hit
  const w = placeKey(v.wo ?? '')
  const onStorey = doc.bereiche.filter((b) => b.floor === v.floor)
  const part = w ? onStorey.find((b) => !!b.name && (w.startsWith(placeKey(b.name)) || placeKey(b.name).startsWith(w))) : undefined
  return part?.id ?? onStorey.find((b) => !b.name)?.id ?? null
}

/** «zuletzt gesehen» in words: the place's label when there is one, else what the record says. */
export function personWhere(doc: SucheDoc, v: PersonView, floorName: (f: number) => string): string {
  const id = personPlace(doc, v, floorName)
  const b = id ? doc.bereiche.find((x) => x.id === id) : undefined
  return b ? placeLabel(b, floorName) : whereText(v.floor, v.wo, floorName)
}

/** Where a person was FOUND, in words: the place the latest find names (a correction moves it),
 *  else the words the find — or its correction — said. */
export function foundWhere(doc: SucheDoc, p: SuchePerson, v: PersonView, floorName: (f: number) => string): string {
  const id = foundBereiche(p).slice(-1)[0]
  const b = id ? doc.bereiche.find((x) => x.id === id) : undefined
  return b ? placeLabel(b, floorName) : whereText(v.foundFloor, v.foundWo, floorName)
}

/** One place on the list and the people who belong to it. */
export interface OrtView {
  /** the place's id — or `txt:<words>` for a place only a person's words name (no record, so
   *  nothing to tick), or `unbekannt` */
  key: string
  bereich?: BereichView
  label: string
  personen: PersonView[]
  /** people still missing here (a group counts its missing) */
  missing: number
  /** somebody is still missing here: a red edge, and it sorts first */
  hot: boolean
  /** abgesucht and nobody missing: it goes quiet and sinks to the end */
  quiet: boolean
}

export interface SucheOrte {
  /** «Ort unbekannt» — people reported with no place; null when there are none */
  unbekannt: OrtView | null
  orte: OrtView[]
  /** people still missing, everywhere */
  missing: number
  /** the places that are records, and how many of them are abgesucht */
  done: number
  total: number
}

/** Is this record a place somebody entered? Everything is — except a step-1 storey row the
 *  machine seeded that nobody ever touched: that was never anybody's entry (nothing preset). */
function isShown(doc: SucheDoc, b: SucheBereich, used: ReadonlySet<string>): boolean {
  return !isStoreyRow(b) || b.log.length > 0 || used.has(b.id)
}

/** The group a person stands in: a person still missing where they were last seen, a found one
 *  where they were found (the mockup's «Treppenhaus · Beispiel Anna ✓»), else last seen. */
function personGroup(doc: SucheDoc, p: SuchePerson, v: PersonView, floorName: (f: number) => string): { id: string | null; text: string } {
  if (v.found > 0 && v.missing === 0 && v.status !== 'entwarnt' && v.status !== 'irrtuemlich') {
    const id = foundBereiche(p).slice(-1)[0]
    if (id && doc.bereiche.some((b) => b.id === id)) return { id, text: '' }
  }
  return { id: personPlace(doc, v, floorName), text: whereText(v.floor, v.wo, floorName) }
}

/**
 * The ONE list, by place (owner's design «F», 26.09.2026). People without a place stand at the top
 * under «Ort unbekannt»; then every place in the order it was entered — except that a place where
 * somebody is still missing sorts FIRST (with a red edge), and a place that is abgesucht with
 * nobody missing goes quiet and sinks to the END. The same list is a plain sweep when nobody is
 * missing at all.
 */
export function sucheOrte(doc: SucheDoc, floorName: (f: number) => string): SucheOrte {
  const views = personenViews(doc)
  const recs = new Map(doc.personen.map((p) => [p.id, p]))
  const placed = views.map((v) => ({ v, g: personGroup(doc, recs.get(v.id)!, v, floorName) }))
  const used = new Set([...placed.map((x) => x.g.id).filter((x): x is string => !!x), ...doc.personen.flatMap(foundBereiche)])
  const byPlace = new Map<string, PersonView[]>()
  const loose: PersonView[] = []
  const textual = new Map<string, { label: string; personen: PersonView[] }>()
  for (const { v, g } of placed) {
    if (g.id) (byPlace.get(g.id) ?? byPlace.set(g.id, []).get(g.id)!).push(v)
    else if (g.text) {
      const k = `txt:${placeKey(g.text)}`
      ;(textual.get(k) ?? textual.set(k, { label: g.text, personen: [] }).get(k)!).personen.push(v)
    } else loose.push(v)
  }
  const missingOf = (ps: PersonView[]) => ps.reduce((n, v) => n + v.missing, 0)
  const orte: OrtView[] = [
    ...doc.bereiche.filter((b) => isShown(doc, b, used)).map((b): OrtView => {
      const bv = bereichView(doc, b, floorName)
      const personen = byPlace.get(b.id) ?? []
      const missing = missingOf(personen)
      return { key: b.id, bereich: bv, label: bv.label, personen, missing, hot: missing > 0, quiet: missing === 0 && bv.status === 'abgesucht' }
    }),
    ...[...textual].map(([key, t]): OrtView => {
      const missing = missingOf(t.personen)
      return { key, label: t.label, personen: t.personen, missing, hot: missing > 0, quiet: missing === 0 }
    }),
  ]
  const rank = (o: OrtView) => (o.hot ? 0 : o.quiet ? 2 : 1)
  // a stable sort: within a rank, the order things were entered
  const sorted = orte.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o)
  const real = sorted.filter((o) => o.bereich)
  const unbekannt = loose.length
    ? { key: 'unbekannt', label: appConfig.copy.suche.ortUnbekannt, personen: loose, missing: missingOf(loose), hot: missingOf(loose) > 0, quiet: false }
    : null
  return {
    unbekannt,
    orte: sorted,
    missing: views.reduce((n, v) => n + v.missing, 0),
    done: real.filter((o) => o.bereich!.status === 'abgesucht').length,
    total: real.length,
  }
}

/** The places on the list that are records, as views — the Ziel chips, the Abschluss, the Rapport. */
export function shownBereiche(doc: SucheDoc, floorName: (f: number) => string): BereichView[] {
  return sucheOrte(doc, floorName).orte.flatMap((o) => (o.bereich ? [o.bereich] : []))
}

/** «2 vermisst · 1/3 abgesucht» — the card's head. Nobody missing says nothing about it (a sweep
 *  with nobody to find is the other half of the Suche, not «0 vermisst»); no places, no fraction. */
export function sucheHeadLine(o: Pick<SucheOrte, 'missing' | 'done' | 'total'>): string {
  const C = appConfig.copy.suche
  return [
    o.missing > 0 ? fillTemplate(C.vermisstChip, { n: o.missing }) : '',
    o.total > 0 ? fillTemplate(C.headAbgesucht, { done: o.done, total: o.total }) : '',
  ].filter(Boolean).join(' · ')
}

/** The Trupp searching a place now — «in Arbeit» or «teilweise» with a Trupp. */
export function truppAt(b: Pick<BereichView, 'status' | 'trupp' | 'truppId'> | undefined): { label: string; id?: string } | undefined {
  if (!b?.trupp || (b.status !== 'inArbeit' && b.status !== 'teilweise')) return undefined
  return { label: b.trupp, id: b.truppId }
}

/**
 * Where a Trupp is searching, for «Fund melden» (walk-through 25.09.2026, F7): the place it works
 * on NOW («in Arbeit» / «teilweise», the latest), else the place its Ziel names. Never the
 * missing person's «zuletzt gesehen» — a find is reported from where the Trupp is.
 */
export function truppPlace(doc: SucheDoc, truppId: string, floorName: (f: number) => string, ziel?: string): string | undefined {
  const mine = doc.bereiche
    .map((b) => ({ b, st: bereichStatusOf(b) }))
    .filter(({ st }) => (st.status === 'inArbeit' || st.status === 'teilweise') && st.truppId === truppId)
    .sort((a, c) => c.st.at.localeCompare(a.st.at))
  return mine[0]?.b.id ?? (ziel?.trim() ? findPlace(doc, ziel, floorName) ?? undefined : undefined)
}

/**
 * The questions standing on the list: a place still «in Arbeit» with a Trupp that is out
 * («Trupp 4 raus – abgesucht? Ja / Teilweise / Nein»). DERIVED, never stored and never modal —
 * so it survives a reload, reaches every editor device (the Raus may have been booked on a
 * handed-over board), and a question nobody answers writes nothing at all.
 */
export function pendingAsks(bereiche: readonly BereichView[], truppOut: (truppId: string) => boolean): BereichView[] {
  return bereiche.filter((u) => u.status === 'inArbeit' && !!u.truppId && truppOut(u.truppId))
}

// ── writes: each returns the NEW doc (or the same object when nothing changed) + the rows ───

const appendRow = <T extends { id: string; log: SucheRow[] }>(list: T[], id: string, row: SucheRow): T[] =>
  list.map((x) => (x.id === id ? { ...x, log: [...x.log, row] } : x))

export interface VermisstInput {
  name?: string
  count?: number
  /** «Wo zuletzt gesehen?» — free words; a place on the list, or a new one (empty = unbekannt) */
  wo?: string
  quelle?: string
  /** «📍 Auf Karte / Plan setzen» in the form: where it was (lib/suche · pointTarget) */
  point?: SuchePoint
  /** step-1 callers only: a storey */
  floor?: number
}

/**
 * Where a point set in «＋ Vermisst» belongs (26.09.2026): on the PLACE when the place has none
 * yet (a new place, or one nobody put on the Karte) — the place is what gets searched and ticked;
 * on the PERSON when there is no place at all («Ort unbekannt», a red person pin of its own).
 * A place that already stands somewhere keeps its pin — the form offers no second one then.
 */
export function pointTarget(doc: SucheDoc, placeId: string | null): 'bereich' | 'person' | null {
  if (!placeId) return 'person'
  return doc.bereiche.find((b) => b.id === placeId)?.point ? null : 'bereich'
}

const seg = (tpl: string, v: Record<string, string | number>, on: unknown) => (on ? fillTemplate(tpl, v) : '')

/** «Klasse 3c (22 Pers.)» — a group says its size wherever it is named in a row */
function nameWithCount(p: Pick<SuchePerson, 'name' | 'count'>): string {
  const C = appConfig.copy.suche
  return personLabel(p) + (p.count && p.count >= 2 ? ` (${fillTemplate(C.groupPersons, { n: p.count })})` : '')
}

/** «Vermisst: Klasse 3c (22 Pers.) · zuletzt Werkraum · Quelle Hauswart» */
export function vermisstText(p: VermisstInput, floorName: (f: number) => string): string {
  const C = appConfig.copy.suche
  const where = whereText(p.floor, p.wo, floorName)
  return fillTemplate(C.rowVermisst, { name: nameWithCount(p) })
    + seg(C.rowZuletzt, { wo: where }, where)
    + seg(C.rowQuelle, { quelle: p.quelle?.trim() ?? '' }, p.quelle?.trim())
}

/** The typed place, resolved: the place on the list it names (created when new), and the words
 *  the record keeps — the place's own label, so «keller» typed reads «Keller» everywhere. */
function placeFor(doc: SucheDoc, wo: string | undefined, cx: SucheCx): { doc: SucheDoc; id: string | null; wo?: string } {
  const r = ensurePlace(doc, wo ?? '', cx)
  const b = r.id ? r.doc.bereiche.find((x) => x.id === r.id) : undefined
  return { doc: r.doc, id: r.id, wo: b ? placeLabel(b, cx.floorName) : undefined }
}

function newPerson(input: VermisstInput & { bereichId?: string | null }, cx: SucheCx, log: SucheRow[], id: string): SuchePerson {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const clean = (s?: string) => s?.trim() || undefined
  return {
    id,
    ...(clean(input.name) ? { name: clean(input.name) } : {}),
    ...(count ? { count } : {}),
    ...(input.floor != null ? { floor: input.floor } : {}),
    ...(clean(input.wo) ? { wo: clean(input.wo) } : {}),
    ...(input.bereichId ? { bereichId: input.bereichId } : {}),
    ...(clean(input.quelle) ? { quelle: clean(input.quelle) } : {}),
    createdAt: cx.at,
    log,
  }
}

/**
 * «＋ Vermisst»: the person, and — when the place typed is new — the place, in ONE doc, so one ↶
 * takes both back. The person points at the place (`bereichId`), which keeps them together through
 * a rename.
 */
export function addPerson(doc: SucheDoc, input: VermisstInput, cx: SucheCx): { doc: SucheDoc; person: SuchePerson; row: SucheRow } {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const place = input.floor == null ? placeFor(doc, input.wo, cx) : { doc, id: null, wo: input.wo }
  const { point, ...rest } = input
  const at = { ...rest, count, wo: place.wo }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'vermisst', text: vermisstText(at, cx.floorName) }
  const target = point ? pointTarget(place.doc, place.id) : null
  const person = newPerson({ ...at, bereichId: place.id }, cx, [row], cx.newId('sp'))
  // …and the pin in the same act, so the one ↶ takes it with the rest
  const bereiche = target === 'bereich' ? place.doc.bereiche.map((b) => (b.id === place.id ? { ...b, point } : b)) : place.doc.bereiche
  const withPoint = target === 'person' ? { ...person, point } : person
  return { doc: { ...place.doc, bereiche, personen: [...place.doc.personen, withPoint] }, person: withPoint, row }
}

export interface GefundenInput {
  /** how many of a group (ignored for a single person) */
  n?: number
  trupp?: string
  truppId?: string
  /** the place it happened in — a place on the list … */
  bereichId?: string
  /** … or the words (a new place is created) */
  wo?: string
  /** optional handover in the same breath («weiter an») — on the SAME row */
  an?: string
}

/** The ONE row a find writes: «Gefunden: Tim Muster · Keller · Trupp 3 · an Rettungsdienst». It
 *  names the place it happened in, which is what makes that place wear «Fund». */
function gefundenRow(doc: SucheDoc, label: string, group: boolean, n: number | undefined, input: GefundenInput, cx: SucheCx): { doc: SucheDoc; row: SucheRow } {
  const C = appConfig.copy.suche
  const byId = input.bereichId ? doc.bereiche.find((b) => b.id === input.bereichId) : undefined
  const place = byId ? { doc, id: byId.id, wo: placeLabel(byId, cx.floorName) } : placeFor(doc, input.wo, cx)
  const where = place.wo ?? ''
  const an = input.an?.trim()
  const text = (group ? fillTemplate(C.rowGefundenGroup, { n: n ?? 1, name: label }) : fillTemplate(C.rowGefunden, { name: label }))
    + seg(C.rowWo, { wo: where }, where)
    + seg(C.rowTrupp, { trupp: input.trupp ?? '' }, input.trupp)
    + seg(C.rowAn, { an: an ?? '' }, an)
  return {
    doc: place.doc,
    row: {
      id: cx.newId('sr'), at: cx.at, op: 'gefunden', text,
      ...(n != null ? { n } : {}),
      ...(input.trupp ? { trupp: input.trupp } : {}),
      ...(input.truppId ? { truppId: input.truppId } : {}),
      ...(place.id ? { bereichId: place.id } : {}),
      ...(where ? { wo: where } : {}),
      ...(an ? { an } : {}),
    },
  }
}

export function personGefunden(doc: SucheDoc, personId: string, input: GefundenInput, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const view = personView(p)
  if (view.missing <= 0) return { doc, rows: [] }
  const n = view.group ? Math.max(1, Math.min(view.count - view.found, Math.round(input.n ?? (view.count - view.found)))) : undefined
  const r = gefundenRow(doc, view.label, view.group, n, input, cx)
  return { doc: { ...r.doc, personen: appendRow(r.doc.personen, personId, r.row) }, rows: [r.row] }
}

/** «+ Gefunden»: somebody found who was never reported missing. ONE row, «Gefunden: …» — never a
 *  «Vermisst: …» with a time nobody reported. They stand where they were found. */
export function addFoundPerson(doc: SucheDoc, input: VermisstInput, found: GefundenInput, cx: SucheCx): { doc: SucheDoc; person: SuchePerson; row: SucheRow } {
  const count = input.count && input.count >= 2 ? Math.round(input.count) : undefined
  const label = nameWithCount({ name: input.name, count })
  const r = gefundenRow(doc, label, !!count, count, found, cx)
  const person = newPerson({ ...input, wo: r.row.wo, bereichId: r.row.bereichId }, cx, [r.row], cx.newId('sp'))
  return { doc: { ...r.doc, personen: [...r.doc.personen, person] }, person, row: r.row }
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

/** Why a record ends without a find, and who said so (N7) — both optional, both in the row. */
export interface SucheWhy { grund?: string; quelle?: string }

function whyFields(why: SucheWhy | undefined): { text: string; fields: Pick<SucheRow, 'grund' | 'quelle'> } {
  const C = appConfig.copy.suche
  const grund = why?.grund?.trim() || undefined
  const quelle = why?.quelle?.trim() || undefined
  return {
    text: seg(C.rowGrund, { grund: grund ?? '' }, grund) + seg(C.rowQuelle, { quelle: quelle ?? '' }, quelle),
    fields: { ...(grund ? { grund } : {}), ...(quelle ? { quelle } : {}) },
  }
}

export function personEntwarnt(doc: SucheDoc, personId: string, cx: SucheCx, why?: SucheWhy): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const w = whyFields(why)
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'entwarnt', text: fillTemplate(appConfig.copy.suche.rowEntwarnt, { name: personView(p).label }) + w.text, ...w.fields }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/** How a person reads in a correction row: «Klasse 3c (22 Pers.) · zuletzt Keller» */
function personSummary(v: Pick<SuchePerson, 'name' | 'count'>, where: string): string {
  return nameWithCount(v) + seg(appConfig.copy.suche.rowZuletzt, { wo: where }, where)
}

/**
 * «Korrigiert: Tim Mustr → Tim Muster · zuletzt Keller» — the name, the size of a group or where
 * the person was last seen (or found), as a ROW: the record keeps what was first said, the fold
 * shows what is true. A place typed new becomes a place in the same act. Only what actually
 * changed is carried; nothing changed writes nothing.
 */
export function personKorrigiert(doc: SucheDoc, personId: string, next: { name?: string; count?: number; wo?: string; foundWo?: string }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p) return { doc, rows: [] }
  const view = personView(p)
  const fix = corrected(p)
  const C = appConfig.copy.suche
  const wasWhere = personWhere(doc, view, cx.floorName)
  let d = doc
  const set: NonNullable<SucheRow['set']> = {}
  const want = {
    name: next.name?.trim() || undefined,
    count: next.count && next.count >= 2 ? Math.round(next.count) : undefined,
  }
  // only what the caller says: a correction of the place alone is not «no name»
  if ('name' in next && want.name !== fix.name) set.name = want.name ?? ''
  if ('count' in next && want.count !== fix.count) set.count = want.count ?? 1
  let nowWhere = wasWhere
  if ('wo' in next && placeKey(next.wo ?? '') !== placeKey(wasWhere)) {
    const place = placeFor(d, next.wo, cx)
    d = place.doc
    nowWhere = place.wo ?? ''
    set.wo = place.wo ?? ''
    set.bereichId = place.id
    // a step-1 storey goes with the words it came with
    if (fix.floor != null) set.floor = null
  }
  // …and where the person was FOUND, once somebody found them (the latest find)
  let foundFrom = ''
  let foundTo = ''
  if (view.found > 0 && 'foundWo' in next) {
    const was = foundWhere(doc, p, view, cx.floorName)
    if (placeKey(next.foundWo ?? '') !== placeKey(was)) {
      const place = placeFor(d, next.foundWo, cx)
      d = place.doc
      set.foundWo = place.wo ?? ''
      set.foundBereichId = place.id
      if (view.foundFloor != null) set.foundFloor = null
      foundFrom = fillTemplate(C.rowGefundenOrt, { wo: was || C.unbekannt })
      foundTo = fillTemplate(C.rowGefundenOrt, { wo: place.wo || C.unbekannt })
    }
  }
  if (!Object.keys(set).length) return { doc, rows: [] }
  const text = fillTemplate(C.rowKorrigiert, {
    from: personSummary(fix, wasWhere) + foundFrom,
    to: personSummary({ name: 'name' in set ? want.name : fix.name, count: 'count' in set ? want.count : fix.count }, nowWhere) + foundTo,
  })
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'korrigiert', text, set }
  return { doc: { ...d, personen: appendRow(d.personen, personId, row) }, rows: [row] }
}

/** «Irrtümlich erfasst: Tim Muster» — the record is withdrawn; it counts nowhere from here on. */
export function personIrrtuemlich(doc: SucheDoc, personId: string, cx: SucheCx, why?: SucheWhy): { doc: SucheDoc; rows: SucheRow[] } {
  const p = doc.personen.find((x) => x.id === personId)
  if (!p || p.log.some((r) => r.op === 'irrtuemlich')) return { doc, rows: [] }
  const w = whyFields(why)
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'irrtuemlich', text: fillTemplate(appConfig.copy.suche.rowIrrtuemlich, { name: personView(p).label }) + w.text, ...w.fields }
  return { doc: { ...doc, personen: appendRow(doc.personen, personId, row) }, rows: [row] }
}

/**
 * One tap on a place's status: «Keller abgesucht · Trupp 4». Setting the status it already has
 * (same Trupp) writes nothing — a second tap is not a second event.
 */
export function setBereichStatus(doc: SucheDoc, id: string, status: SucheBereichStatus, trupp: { label?: string; id?: string } | undefined, cx: SucheCx, note?: string): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const b = doc.bereiche.find((x) => x.id === id)
  if (!b) return { doc, rows: [] }
  const cur = bereichStatusOf(b)
  // «abgesucht» after «in Arbeit · Trupp 4» is Trupp 4's unless somebody says otherwise
  const label = status === 'offen' ? undefined : (trupp?.label ?? cur.trupp)
  const tid = status === 'offen' ? undefined : (trupp?.label ? trupp.id : cur.truppId)
  if (cur.status === status && cur.trupp === label && !note) return { doc, rows: [] }
  // `note` says what the status alone cannot — «teilweise abgesucht» at a Trupp's Raus
  const text = fillTemplate(C.rowBereich, { bereich: placeLabel(b, cx.floorName), status: note ?? C.bereichStatus[status] }) + seg(C.rowTrupp, { trupp: label ?? '' }, label)
  const row: SucheRow = {
    id: cx.newId('sr'), at: cx.at, op: 'status', status, text,
    ...(label ? { trupp: label } : {}),
    ...(label && tid ? { truppId: tid } : {}),
  }
  return { doc: { ...doc, bereiche: appendRow(doc.bereiche, id, row) }, rows: [row] }
}

/** The tick circle on a place's row (design «F»): offen / in Arbeit / teilweise → abgesucht, and
 *  abgesucht → back to offen. One row either way, like any other status. */
export function toggleAbgesucht(doc: SucheDoc, id: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const b = doc.bereiche.find((x) => x.id === id)
  if (!b) return { doc, rows: [] }
  return setBereichStatus(doc, id, bereichStatusOf(b).status === 'abgesucht' ? 'offen' : 'abgesucht', undefined, cx)
}

/** «Fund: Keller» — the place's own mark, set on the place (a find booked on a PERSON marks its
 *  place through its own row instead). */
export function markFund(doc: SucheDoc, id: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const b = doc.bereiche.find((x) => x.id === id)
  if (!b || bereichStatusOf(b, doc).fund) return { doc, rows: [] }
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'fund', text: fillTemplate(C.rowFund, { bereich: placeLabel(b, cx.floorName) }) }
  return { doc: { ...doc, bereiche: appendRow(doc.bereiche, id, row) }, rows: [row] }
}

/** A new name — never one another place already carries: two places that read the same would be
 *  one place to everybody reading the list, and to the text match that finds a Trupp's Ziel. */
export function renameBereich(doc: SucheDoc, id: string, name: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const b = doc.bereiche.find((x) => x.id === id)
  const next = name.trim().replace(/\s+/g, ' ')
  if (!b || !b.name || !next || next === b.name) return { doc, rows: [] }
  const renamed = { ...b, name: next }
  const clash = findPlace({ ...doc, bereiche: doc.bereiche.filter((x) => x.id !== id) }, placeLabel(renamed, cx.floorName), cx.floorName)
  if (clash) return { doc, rows: [] }
  const from = placeLabel(b, cx.floorName)
  const to = placeLabel(renamed, cx.floorName)
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'umbenannt', text: fillTemplate(appConfig.copy.suche.rowUmbenannt, { from, to }) }
  return { doc: { ...doc, bereiche: doc.bereiche.map((x) => (x.id === id ? { ...renamed, log: [...x.log, row] } : x)) }, rows: [row] }
}

/** «＋ Bereich»: a place by its name, and optionally the Trupp that searches it — one act. A name
 *  the list already has is FOUND, not duplicated (and the Trupp, if one was picked, goes there). */
export function addBereich(doc: SucheDoc, input: { name: string; trupp?: { label: string; id?: string }; point?: SuchePoint }, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; id: string | null } {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) return { doc, rows: [], id: null }
  const found = findPlace(doc, name, cx.floorName)
  let d = doc
  let id = found
  const rows: SucheRow[] = []
  if (!found) {
    const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'angelegt', text: fillTemplate(appConfig.copy.suche.rowAngelegt, { name }) }
    const b: SucheBereich = { id: cx.newId('sb'), name, createdAt: cx.at, ...(input.point ? { point: input.point } : {}), log: [row] }
    d = { ...doc, bereiche: [...doc.bereiche, b] }
    id = b.id
    rows.push(row)
  }
  if (input.trupp && id) {
    const r = setBereichStatus(d, id, 'inArbeit', input.trupp, cx)
    d = r.doc
    rows.push(...r.rows)
  }
  return { doc: d, rows, id }
}

/**
 * The place a Trupp's Ziel names, CREATING it when it is new — resolved against the doc handed in,
 * which must be the writer's latest. A Ziel is words like any other place: «Keller», «Wohnung 2.
 * OG links»; a step-1 label («1. OG Trakt 3») still finds its old record.
 */
export function zielBereich(doc: SucheDoc, ziel: string, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[]; id: string | null } {
  return addBereich(doc, { name: ziel }, cx)
}

/**
 * Put a place (or a person) on the Karte or a plan, move it, or take it off again — the same
 * record, its `point` set or cleared, and ONE row that says so (the ↶ names it). Nothing moved
 * writes nothing.
 */
export function setPlacePoint(doc: SucheDoc, kind: 'bereiche' | 'personen', id: string, point: SuchePoint | null, cx: SucheCx): { doc: SucheDoc; rows: SucheRow[] } {
  const C = appConfig.copy.suche
  const list = doc[kind] as (SucheBereich | SuchePerson)[]
  const rec = list.find((x) => x.id === id)
  if (!rec) return { doc, rows: [] }
  const was = rec.point
  if (JSON.stringify(was ?? null) === JSON.stringify(point ?? null)) return { doc, rows: [] }
  const label = kind === 'bereiche' ? placeLabel(rec as SucheBereich, cx.floorName) : personView(rec as SuchePerson).label
  const where = point?.planId ? C.onPlan : C.onKarte
  const tpl = !point ? C.rowOrtWeg : was ? C.rowOrtVerschoben : C.rowOrtGesetzt
  const row: SucheRow = { id: cx.newId('sr'), at: cx.at, op: 'ort', text: fillTemplate(tpl, { name: label, wo: where }) }
  const next = list.map((x) => {
    if (x.id !== id) return x
    // absent, never `undefined`: the merge compares by JSON, and a key that says nothing is noise
    const { point: _was, ...rest } = x
    void _was
    return { ...rest, ...(point ? { point } : {}), log: [...x.log, row] }
  })
  return { doc: { ...doc, [kind]: next } as SucheDoc, rows: [row] }
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

// ⚠️ An ABSENT field travels as `null` (26.09.2026): the patch goes over the wire as JSON (the
// audit event replay folds), where `undefined` simply vanishes — «the pin was taken off» arrived
// as an empty `after` and replay kept the pin. No record field is ever null, so null = absent.
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

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
        f0[k] = o[k] ?? null; f1[k] = n[k] ?? null
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
  for (const [k, v] of Object.entries(vals)) { if (v == null) delete out[k]; else out[k] = v }
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

// ── pins: where places (and people without one) stand on the Karte and the plans ─────────

/**
 * One pin on a surface (26.09.2026, the owner's answer on the overlay): a place where somebody put
 * it, coloured by its status, with a red ring while somebody is still missing there — and a person
 * still missing who stands somewhere but belongs to no place, as a red pin of their own.
 */
export interface SuchePin {
  /** the record's id — a tap opens the card on it */
  id: string
  kind: 'bereich' | 'person'
  /** «Keller», «Wohnung 2. OG links · T1» (in Arbeit names the Trupp), «Muster Tim» */
  label: string
  /** a place's status; a person pin is always «vermisst» */
  status: SucheBereichStatus | 'vermisst'
  /** somebody is still missing here */
  hot: boolean
  point: SuchePoint
}

export function suchePins(doc: SucheDoc, floorName: (f: number) => string): SuchePin[] {
  const o = sucheOrte(doc, floorName)
  const out: SuchePin[] = []
  for (const x of o.orte) {
    const b = x.bereich
    if (!b?.point) continue
    const t = b.status === 'inArbeit' && b.trupp ? ` · ${truppShort(b.trupp)}` : ''
    out.push({ id: b.id, kind: 'bereich', label: b.label + t, status: b.status, hot: x.hot, point: b.point })
  }
  // a person with a pin of their own: only while missing, and only without a place (a place's
  // pin already stands for everybody there)
  const placed = new Set(o.orte.filter((x) => x.bereich).flatMap((x) => x.personen.map((p) => p.id)))
  for (const p of doc.personen) {
    if (!p.point || placed.has(p.id)) continue
    const v = personView(p)
    if (v.missing <= 0) continue
    out.push({ id: p.id, kind: 'person', label: v.group ? `${v.label} (${v.missing})` : v.label, status: 'vermisst', hot: true, point: p.point })
  }
  return out
}

/** The pins that stand on the Karte, as the Kroki's notes (lib/reportPdfDirect): the printed map
 *  says what the screen said — «Suche: Keller · abgesucht» — in the status colour. They ride the
 *  tactical layer, so they print exactly when the tactical symbols do. */
export function sucheKrokiNotes(doc: SucheDoc | undefined, floorName: (f: number) => string, layer: LayerId): Entity[] {
  if (!doc) return []
  const C = appConfig.copy.suche
  const color: Record<SuchePin['status'], string> = { vermisst: '#d62f2f', offen: '#5b6576', inArbeit: '#1f6fe5', teilweise: '#2e8f86', abgesucht: '#1e8a4a', nichtZugaenglich: '#b86e00' }
  return suchePins(doc, floorName).filter((p) => p.point.coord).map((p): Entity => ({
    id: `suche-${p.id}`, kind: 'note', layer, coord: p.point.coord!,
    label: fillTemplate(C.krokiPin, { name: p.label, status: p.kind === 'person' ? C.status.vermisst : C.bereichStatus[p.status as SucheBereichStatus] })
      + (p.kind === 'bereich' && p.hot ? ` · ${C.krokiHot}` : ''),
    color: p.hot ? color.vermisst : color[p.status],
  }))
}

// ── the Trupps, as the Suche names them ─────────────────────────────────────────────────────

export interface TruppHere {
  id: string
  /** «Trupp 3» — the paper name */
  label: string
  /** «T3 Muster» — the chip */
  short: string
  /** the board's status («angemeldet», «raus», …) — «Wer sucht?» offers only a Trupp that can */
  status?: string
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

/** A text's words, as the matching reads them: lower-case, accents folded, punctuation dropped. */
const wordsOf = (text: string) => norm(text).split(/[\s()[\]/,.:;!?+·–—«»"'-]+/).filter(Boolean)

/**
 * Named people still missing that a sentence is ABOUT — offered as «Eva Beispiel · vermisst →
 * gefunden» (a group: «Klasse 4b · 2 von 5 gefunden»). Either rule is enough:
 * - TYPING: every typed word of ≥ 2 letters starts a word of the name — «eva bei» finds «Eva
 *   Beispiel», «eva» alone does too, but «va» does not;
 * - NAMED: every word of the name stands in the sentence, anywhere — «2 Kinder der Klasse 4b»,
 *   «Klasse 4b: 3 gefunden», «Eva Beispiel am Sammelplatz» (walk-through 25.09.2026, R2: a group
 *   was only offered for a text that was nothing but its name, so a count in the sentence could
 *   never be used). «eva im Keller» still finds nobody: «Beispiel» is not in it.
 * A record the sentence NAMES ranks before one it only begins to type.
 */
export function suggestSuchePersonen(text: string, personen: readonly PersonView[], limit = 2): PersonView[] {
  const typed = norm(text).split(/\s+/).filter((w) => w.length >= 2)
  const said = new Set(wordsOf(text))
  if (!typed.length && !said.size) return []
  const C = appConfig.copy.suche
  return personen
    .filter((p) => p.status === 'vermisst' && p.label !== C.unnamed && p.label !== C.groupUnnamed)
    .map((p) => {
      const nameWords = wordsOf(p.label)
      const named = nameWords.length > 0 && nameWords.every((w) => said.has(w))
      const typing = typed.length > 0 && typed.every((w) => startsAWord(w, p.label))
      return { p, named, typing, score: typed.reduce((sum, w) => sum + fuzzyScore(w, p.label), 0) }
    })
    .filter((m) => m.named || m.typing)
    .sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || a.p.firstAt.localeCompare(b.p.firstAt))
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
  /** «zuletzt Technikraum · Quelle Hauswart» */
  detail?: string
  /** HH:MM reported missing — «–» for somebody found who was never reported */
  vermisst: string
  /** «20:16 · Trupp 3 · Keller» (a group: «20 / 22 gefunden · 20:16 …») */
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
  const recs = new Map(doc.personen.map((p) => [p.id, p]))
  return doc.personen.map(personView)
    .filter((v) => v.status !== 'irrtuemlich')
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id))
    .map((v) => {
      const where = personWhere(doc, v, floorName)
      const detail = [v.vermisstAt && where ? fillTemplate(C.zuletztLine, { wo: where }) : '', v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '']
        .filter(Boolean).join(' · ')
      const fw = foundWhere(doc, recs.get(v.id)!, v, floorName)
      const gefunden = v.foundAt
        ? [v.group ? fillTemplate(C.groupFound, { found: v.found, count: v.count }) : '', clock(v.foundAt), v.foundTrupp ?? '', fw].filter(Boolean).join(' · ')
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

/**
 * «Suche: 8 Bereiche, alle abgesucht 20:39» — or what is still open. Null when no place was ever
 * entered: a line about areas on the Rapport of a Kaminbrand would claim a search that never
 * happened. The places are the list's (`sucheOrte`), so paper and screen count the same ones.
 */
export function sucheLine(doc: SucheDoc | undefined, floorName: (f: number) => string, clock: (iso: string) => string): string | null {
  if (!doc) return null
  const units = shownBereiche(doc, floorName)
  if (!units.length) return null
  const C = appConfig.copy.suche
  const open = units.filter((u) => u.status !== 'abgesucht')
  // one place is a place of its own in the sentence, not «1 Bereiche» (a sweep of one barn)
  const one = units.length === 1
  if (!open.length) {
    const last = units.map((u) => u.statusAt).sort().pop() ?? ''
    return fillTemplate(one ? C.suchLineAllOne : C.suchLineAll, { n: units.length, t: last ? clock(last) : '' }).trim()
  }
  return fillTemplate(one ? C.suchLineOpenOne : C.suchLineOpen, { n: units.length, done: units.length - open.length, list: open.map((u) => u.label).join(', ') })
}

/** The places not yet abgesucht — the Abschluss's hint line. */
export function openBereiche(doc: SucheDoc | undefined, floorName: (f: number) => string): string[] {
  if (!doc) return []
  return shownBereiche(doc, floorName).filter((u) => u.status !== 'abgesucht').map((u) => u.label)
}

/** «1 Frage» / «3 Fragen» — the open «abgesucht?» questions, wherever they are counted */
export function asksWords(n: number): string {
  const C = appConfig.copy.suche
  return n === 1 ? C.asksOne : fillTemplate(C.asksMany, { n })
}

/**
 * The first question in front of the Abschluss while the Suche still lists people as missing
 * (walk-through 25.09.2026, N6): «8 Personen noch vermisst: Klasse 4b (8), Tim Muster.» — the
 * count and the first names, because «8» alone does not say whether it is one class or eight
 * strangers. At most three names; the rest is counted («+2»).
 */
export function vermisstAbschlussMessage(doc: SucheDoc): string | null {
  const C = appConfig.copy.suche
  const open = personenViews(doc).filter((v) => v.status === 'vermisst' && v.missing > 0)
  const n = open.reduce((sum, v) => sum + v.missing, 0)
  if (!n) return null
  const names = open.slice(0, 3).map((v) => (v.group ? fillTemplate(C.abschlussAskGroup, { name: v.label, n: v.missing }) : v.label))
  const list = names.join(', ') + (open.length > 3 ? ` +${open.length - 3}` : '')
  return n === 1 ? fillTemplate(C.abschlussAskOne, { list }) : fillTemplate(C.abschlussAskMany, { n, list })
}

/** What an entry written in the Verlauf changes in the Suche on its way (Tür 2): a person still
 *  missing is found, or a new one is reported missing under the words before «vermisst». */
export type SucheComposerLink =
  /** `n` of `of` still missing — a GROUP's find always names how many (F6); absent for one person */
  | { kind: 'gefunden'; personId: string; label: string; n?: number; of?: number }
  | { kind: 'neu'; name: string }

/**
 * The composer's «gefunden» offer for one person on the list (walk-through 25.09.2026, F6). For a
 * group it NAMES the count, never «all of them»: a number in the sentence — digits or a number word
 * — that is not part of the group's own name («3 von Klasse 4b gefunden», «zwei Kinder der Klasse
 * 4b») and fits what is still missing, else 1. Typing
 * «Klasse 4b» to say two children turned up had marked all five remaining found.
 */
export function composerFoundLink(text: string, v: PersonView): SucheComposerLink {
  if (!v.group) return { kind: 'gefunden', personId: v.id, label: v.label }
  // the sentence's numbers — digits, or a number word («zwei Kinder») — that are not the name's own
  const own = new Set(wordsOf(v.label))
  const words = appConfig.copy.suche.countWords
  const said = wordsOf(text)
    .filter((w) => !own.has(w))
    .map((w) => (/^\d{1,3}$/.test(w) ? Number(w) : words.indexOf(w) + 1))
    .find((n) => n >= 1 && n <= v.missing)
  return { kind: 'gefunden', personId: v.id, label: v.label, n: said ?? 1, of: v.missing }
}

/** The change in words, for the Verlauf row the entry becomes: «Tim Muster gefunden». */
export function sucheChangeWords(l: SucheComposerLink): string {
  const S = appConfig.copy.suche
  if (l.kind === 'gefunden' && l.n != null) return fillTemplate(S.composerChangeGefundenGroup, { n: l.n, name: l.label })
  return l.kind === 'gefunden'
    ? fillTemplate(S.composerChangeGefunden, { name: l.label })
    : fillTemplate(S.composerChangeNeu, { name: l.name })
}

/**
 * The Verlauf row's «· Suche: …» for an entry that changed a status on its way — or nothing, when
 * the sentence already SAYS that change (confirmation check 26.09.2026): «3 von Klasse 4b
 * gefunden» was written as «3 von Klasse 4b gefunden · Suche: 3 von Klasse 4b gefunden». Said
 * means: every word of the name, the new status word («gefunden» / «vermisst») and — for a group —
 * the count stand in the sentence. Otherwise the structured part is appended, once.
 */
export function composerRowSuffix(text: string, l: SucheComposerLink): string {
  const S = appConfig.copy.suche
  const said = new Set(wordsOf(text))
  const name = l.kind === 'gefunden' ? l.label : l.name
  const status = norm(l.kind === 'gefunden' ? S.status.gefunden : S.status.vermisst)
  const count = l.kind === 'gefunden' && l.n != null
    ? said.has(String(l.n)) || (l.n <= S.countWords.length && said.has(S.countWords[l.n - 1]))
    : true
  const says = wordsOf(name).every((w) => said.has(w)) && said.has(status) && count
  return says ? '' : fillTemplate(S.composerRowSuffix, { change: sucheChangeWords(l) })
}

export function sucheLinkLabel(l: SucheComposerLink): string {
  const S = appConfig.copy.suche
  if (l.kind === 'gefunden' && l.n != null) return fillTemplate(S.composerKnownGroup, { name: l.label, n: l.n, of: l.of ?? l.n })
  return l.kind === 'gefunden'
    ? fillTemplate(S.composerKnown, { name: l.label, from: S.status.vermisst, to: S.status.gefunden })
    : fillTemplate(S.composerNew, { name: l.name })
}

/** A jump into the Suche: open ONE record straight away. */
export interface SucheFocus { personId?: string; bereichId?: string; nonce: number }

/**
 * What the Suche opens on (walk-through 25.09.2026, N17). A jump — a Verlauf row, a Meldeleiste
 * question — names its record and gets a fresh nonce (the panel remounts on it). A PLAIN open is
 * the list: the focus is dropped, so a jump from an hour ago (a «Fund · Trupp 1» form for a Trupp
 * long out) can never come back when somebody taps the head chip.
 */
export function sucheFocusFor(prev: SucheFocus | null, jump?: { personId?: string; bereichId?: string }): SucheFocus | null {
  if (!jump?.personId && !jump?.bereichId) return null
  return { personId: jump.personId, bereichId: jump.bereichId, nonce: (prev?.nonce ?? 0) + 1 }
}
