// Mittel (material-use) derivation. The incident's Mittel record is an APPEND-ONLY log of
// "current total" events keyed by material + unit + optional source (see types · MittelEntry):
// each saved change appends a new event carrying the new running total for that key. The current
// picture is DERIVED here as the latest event per key — never mutated in place — so it folds the
// same way Verlauf/reminders do (append-only doctrine) and merges cleanly three-way by event id.
//
// `menge > 0` means "this much was used"; `menge === 0` is a tombstone that hides the row from the
// views/report but preserves the history (so a mistaken entry can be zeroed without losing the
// trail). No code here removes events.
import type { MittelEntry, MittelStatus } from '../types'

/**
 * A unit reduced to what it MEANS, for comparing two spellings of it.
 *
 * ⚠️ «Stk» and «Stk.» are one unit. They keyed as two, so the same material recorded before and
 * after the catalogue gained its dot split into two lines on the same sheet — «1 Stk Schlauch
 * 75er» directly above «5 Stk. Schlauch 75er», which reads as two different things and adds up
 * to neither. That happens without anybody editing a catalogue: a tablet that was open across a
 * config change writes the spelling it still had.
 *
 * Trailing dots and case only; nothing else is folded. «l» and «L» are the same litre, «kg» and
 * «Kg» the same kilo — but «Sack» and «Stk.» stay different units, which is the distinction the
 * key exists to make in the first place.
 */
const unitKey = (u: string) => u.trim().toLowerCase().replace(/\.+$/, '')

/** The stable identity of a "what was used, from where" line: material + unit + source. Custom
 *  (incident-local) materials/sources have no config id, so they key off their trimmed label.
 *  Unit is part of the key — the same material recorded in `Stk.` and in `l` are separate lines,
 *  but two SPELLINGS of one unit are not (see `unitKey`). */
export function mittelKey(e: Pick<MittelEntry, 'materialId' | 'label' | 'unit' | 'sourceId' | 'sourceLabel'>): string {
  const m = e.materialId ?? `~${e.label.trim().toLowerCase()}`
  const u = unitKey(e.unit)
  const s = e.sourceId ?? (e.sourceLabel ? `~${e.sourceLabel.trim().toLowerCase()}` : '')
  return `${m}|${u}|${s}`
}

/** The current state of one material line, derived from the latest event for its key. */
export interface CurrentMittel {
  key: string
  materialId?: string
  label: string
  unit: string
  sourceId?: string
  sourceLabel?: string
  menge: number
  /** Retablierung state (equipment): zurück / vor Ort geblieben / defekt; undefined = im Einsatz */
  status?: MittelStatus
  /** free remark on the line — the latest one written (see MittelEntry.note) */
  note?: string
  /** nominal stock of an incident-local line (see MittelEntry.stock) */
  stock?: number
  /** the line was explicitly removed (see MittelEntry.deleted) */
  deleted?: boolean
  at: string
  /** id of the latest event — the one a per-row edit appends a successor to */
  entryId: string
}

/** Fold the append-only event log into the latest event per key. ISO `at` strings compare
 *  lexicographically, so the newest event wins regardless of array order (merge can reorder). */
/** Of two spellings of the SAME unit (see `unitKey`), the one to show: the longer, which is the
 *  one carrying the abbreviation's dot. Falls back to the newer when there is nothing to compare. */
const fullerUnit = (prev: string | undefined, next: string): string =>
  (prev && unitKey(prev) === unitKey(next) && prev.trim().length > next.trim().length ? prev : next)

export function deriveCurrentMittel(entries: MittelEntry[]): Map<string, CurrentMittel> {
  const out = new Map<string, CurrentMittel>()
  for (const e of entries) {
    const key = mittelKey(e)
    const prev = out.get(key)
    if (!prev || e.at >= prev.at) {
      out.set(key, {
        // ⚠️ The unit comes from the LATEST event, and two spellings now fold into one line — so
        // whichever was written last is what the line shows. Prefer the fuller spelling when they
        // differ («Stk.» over «Stk»): the dot is the station's configured form, and a line that
        // merged an old entry into a new one must not print the older wording of it.
        key, materialId: e.materialId, label: e.label, unit: fullerUnit(prev?.unit, e.unit),
        sourceId: e.sourceId, sourceLabel: e.sourceLabel, menge: e.menge, status: e.status, note: e.note,
        stock: e.stock, deleted: e.deleted, at: e.at, entryId: e.id,
      })
    }
  }
  return out
}

/** The lines that were USED — latest per key, nothing removed, nothing at zero — stably sorted.
 *  This is what the Rapport and the source view read: a line recorded and then corrected back to
 *  zero states that nothing was used, and printing it would say the opposite. */
export function visibleMittel(entries: MittelEntry[]): CurrentMittel[] {
  return recordedMittel(entries).filter((c) => c.menge > 0)
}

/** Every line still on the sheet, INCLUDING the ones standing at zero — what the «Weitere» group
 *  renders. A hand-added line that was stepped down to 0 has to stay in the list: it is the only
 *  handle left for correcting the count back up, renaming it, or removing it on purpose. Only an
 *  explicit removal takes a line out of here. */
export function recordedMittel(entries: MittelEntry[]): CurrentMittel[] {
  return [...deriveCurrentMittel(entries).values()]
    .filter((c) => !c.deleted)
    .sort((a, b) => a.label.localeCompare(b.label, 'de') || a.unit.localeCompare(b.unit, 'de'))
}

/** The current total for a key (0 if never recorded / zeroed) — used to make re-saving the same
 *  value a no-op (no event, no Verlauf row). */
export function currentMengeFor(entries: MittelEntry[], probe: Pick<MittelEntry, 'materialId' | 'label' | 'unit' | 'sourceId' | 'sourceLabel'>): number {
  return deriveCurrentMittel(entries).get(mittelKey(probe))?.menge ?? 0
}

/** The full current line for a key, when one exists — for no-op checks that also cover status. */
export function currentLineFor(entries: MittelEntry[], probe: Pick<MittelEntry, 'materialId' | 'label' | 'unit' | 'sourceId' | 'sourceLabel'>): CurrentMittel | undefined {
  return deriveCurrentMittel(entries).get(mittelKey(probe))
}

/** Source-first grouping (the default view): `TLF → Lüfter 1 Stk`. Items with no source fall
 *  into one trailing group labelled `noSourceLabel`. */
export interface SourceGroup {
  sourceKey: string
  sourceLabel: string
  hasSource: boolean
  items: CurrentMittel[]
}
export function groupBySource(current: CurrentMittel[], noSourceLabel: string): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const c of current) {
    const hasSource = !!(c.sourceId || c.sourceLabel)
    const sourceKey = c.sourceId ?? (c.sourceLabel ? `~${c.sourceLabel.trim().toLowerCase()}` : '')
    const g = groups.get(sourceKey) ?? { sourceKey, sourceLabel: hasSource ? (c.sourceLabel ?? '') : noSourceLabel, hasSource, items: [] }
    g.items.push(c)
    groups.set(sourceKey, g)
  }
  // real sources alphabetical; the "no source" bucket sinks to the bottom
  return [...groups.values()].sort((a, b) =>
    Number(a.hasSource ? 0 : 1) - Number(b.hasSource ? 0 : 1) || a.sourceLabel.localeCompare(b.sourceLabel, 'de'))
}

/** Material-first grouping / report aggregation: one row per material + unit, summed across
 *  sources, with the contributing source labels listed (`Lüfter 2 Stk · TLF, LF`). */
export interface MaterialGroup {
  materialKey: string
  label: string
  unit: string
  total: number
  sources: string[]
  items: CurrentMittel[]
}
export function groupByMaterial(current: CurrentMittel[], noSourceLabel: string): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>()
  for (const c of current) {
    const materialKey = `${c.materialId ?? `~${c.label.trim().toLowerCase()}`}|${c.unit.trim().toLowerCase()}`
    const g = groups.get(materialKey) ?? { materialKey, label: c.label, unit: c.unit, total: 0, sources: [], items: [] }
    g.total += c.menge
    g.items.push(c)
    const src = c.sourceLabel || (c.sourceId ? c.sourceId : noSourceLabel)
    if (!g.sources.includes(src)) g.sources.push(src)
    groups.set(materialKey, g)
  }
  for (const g of groups.values()) g.sources.sort((a, b) => a.localeCompare(b, 'de'))
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'de') || a.unit.localeCompare(b.unit, 'de'))
}

/** Report section rows: visible lines aggregated by material + unit, listing their sources. */
export type MittelReportRow = MaterialGroup
export function mittelReportRows(entries: MittelEntry[], noSourceLabel: string): MittelReportRow[] {
  return groupByMaterial(visibleMittel(entries), noSourceLabel)
}

/** Total distinct visible material lines — for the sheet summary / report toggle count. */
export function mittelLineCount(entries: MittelEntry[]): number {
  return visibleMittel(entries).length
}

// ── Stock / Bestand ────────────────────────────────────────────────────────────────────────
// The deployment config can give each catalogue item a nominal per-source load-out (`stock`,
// e.g. Lüfter → TLF 2, Pio 1). Combined with what was actually used (the log), that yields the
// "used / available" readout on each source line and the Bestand overview. This is display-only
// arithmetic (available − used); nothing decrements a persisted store — still not inventory mgmt.

import type { DeploymentMittelItem, DeploymentMittelSource } from './deploymentConfig'

/** Nominal stock of one material at one source, or undefined when the item carries no stock
 *  config (then the UI shows just the used count, no "/ available"). A source not listed on an
 *  item that DOES have stock means 0 there (→ over-use if used). */
export function availableFor(
  catalogue: DeploymentMittelItem[],
  materialId: string | undefined,
  sourceId: string | undefined,
): number | undefined {
  if (!materialId || !sourceId) return undefined
  const item = catalogue.find((c) => c.id === materialId)
  if (!item?.stock?.length) return undefined
  return item.stock.find((x) => x.source === sourceId)?.qty ?? 0
}

// ── Unified stepper list (the primary Mittel view, decision 2026-07-09) ────────────────────
// ONE list of the whole catalogue (grouped by category, config order) where every row edits
// in place with ±, plus a trailing «Weitere» group for free-typed lines. A row has one cell
// per source that carries stock OR usage; multi-cell rows expand to per-source steppers.

export interface MittelListCell {
  sourceId?: string
  sourceLabel?: string
  /** configured stock at this source; undefined when the item carries no stock config */
  stock?: number
  used: number
  status?: MittelStatus
}
export interface MittelListRow {
  key: string
  materialId?: string
  label: string
  unit: string
  /** incident-local line (no catalogue match) — lives in the trailing custom group */
  custom: boolean
  totalUsed: number
  /** summed configured stock; undefined when the item carries no stock config */
  totalStock?: number
  cells: MittelListCell[]
}
export interface MittelListGroup { category: string; custom: boolean; rows: MittelListRow[] }

export function mittelListGroups(
  entries: MittelEntry[],
  catalogue: DeploymentMittelItem[],
  sources: DeploymentMittelSource[],
  labels: { other: string; custom: string },
): MittelListGroup[] {
  const currentAll = [...deriveCurrentMittel(entries).values()]
  const srcLabel = (id: string) => sources.find((s) => s.id === id)?.label ?? id
  // lines represented by a catalogue row — everything else (free-typed, deleted catalogue
  // items, odd units) falls through to the custom group so no recorded line ever vanishes
  const covered = new Set<string>()

  const groups: MittelListGroup[] = groupCatalogue(catalogue, labels.other).map((g) => ({
    category: g.category,
    custom: false,
    rows: g.items.map((item): MittelListRow => {
      const unit = item.unit ?? 'Stk.'
      const cells = new Map<string, MittelListCell>()
      for (const st of item.stock ?? []) {
        cells.set(st.source, { sourceId: st.source, sourceLabel: srcLabel(st.source), stock: st.qty, used: 0 })
      }
      for (const c of currentAll) {
        if (c.materialId !== item.id || unitKey(c.unit) !== unitKey(unit)) continue
        covered.add(c.key)
        const k = c.sourceId ?? (c.sourceLabel ? `~${c.sourceLabel.trim().toLowerCase()}` : '')
        const cell = cells.get(k)
        if (cell) { cell.used = c.menge; cell.status = c.status }
        else cells.set(k, { sourceId: c.sourceId, sourceLabel: c.sourceLabel, used: c.menge, status: c.status })
      }
      if (cells.size === 0) cells.set('', { used: 0 })
      const list = [...cells.values()].sort((a, b) =>
        (b.stock ?? 0) - (a.stock ?? 0) || (a.sourceLabel ?? '').localeCompare(b.sourceLabel ?? '', 'de'))
      return {
        key: item.id, materialId: item.id, label: item.label, unit, custom: false,
        totalUsed: list.reduce((n, c) => n + c.used, 0),
        totalStock: item.stock?.length ? item.stock.reduce((n, st) => n + st.qty, 0) : undefined,
        cells: list,
      }
    }),
  }))

  // recordedMittel, not visibleMittel: a hand-added line stepped down to 0 stays on the sheet.
  // It is the only handle left for putting the count back, renaming it or removing it on purpose
  // — and it does NOT reach the Rapport, which reads visibleMittel.
  const customRows = recordedMittel(entries)
    .filter((c) => !covered.has(c.key))
    .map((c): MittelListRow => ({
      key: c.key, materialId: c.materialId, label: c.label, unit: c.unit, custom: true, totalUsed: c.menge,
      totalStock: c.stock,
      cells: [{ sourceId: c.sourceId, sourceLabel: c.sourceLabel, stock: c.stock, used: c.menge, status: c.status }],
    }))
  if (customRows.length) groups.push({ category: labels.custom, custom: true, rows: customRows })
  return groups.filter((g) => g.rows.length > 0)
}

export interface CatalogueGroup { category: string; items: DeploymentMittelItem[] }
/** Group the catalogue by category (config order; uncategorised → trailing `fallback` bucket)
 *  for the grouped picker + Bestand sections. */
export function groupCatalogue(catalogue: DeploymentMittelItem[], fallback: string): CatalogueGroup[] {
  const groups: CatalogueGroup[] = []
  const idx = new Map<string, CatalogueGroup>()
  for (const item of catalogue) {
    const cat = item.category || fallback
    let g = idx.get(cat)
    if (!g) { g = { category: cat, items: [] }; idx.set(cat, g); groups.push(g) }
    g.items.push(item)
  }
  // keep config order, but always sink the fallback (uncategorised) bucket to the end
  return groups.sort((a, b) => Number(a.category === fallback) - Number(b.category === fallback))
}

// ── Symbol → Mittel capture ────────────────────────────────────────────────────────────────
// Placing a tactical symbol on Lage/Plan can OFFER logging the matching material (one tap, never
// automatic — symbols are freely deleted/redrawn, auto-counting would overcount; deleting a
// symbol never decrements). The match: an explicit catalogue `symbol` key wins; otherwise the
// catalogue label's tokens must all appear as whole words in the symbol name ("Lüfter" matches
// "VKF Luefter mobil", but "Leiter" does NOT match "VKF Einsatzleiter").

/** Normalize for matching: lowercase, umlauts AND their ascii digraphs collapse the same way
 *  (catalogue labels carry real umlauts, symbol pack names carry ue/oe/ae transliterations). */
function normToken(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/é|è/g, 'e')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
}
const tokens = (s: string) => normToken(s).split(/[^a-z0-9]+/).filter(Boolean)

/** What a placed symbol is, as far as the catalogue is concerned: its pack name plus whatever
 *  its own fields say about it. `Luftrichtung` is synthesised from the airflow flag — a Lüfter
 *  set to extract IS an Exhauster, and that state lives outside `fields`. */
export interface SymbolMatch {
  symbol: string
  fields?: Record<string, string | undefined>
  /** true = saugen (Absaugen), false/absent = blasen */
  extract?: boolean
}

/** The pseudo-field the airflow flag answers to in a catalogue `when` clause. */
export const AIRFLOW_FIELD = 'Luftrichtung'
export const AIRFLOW_EXTRACT = 'saugen'
export const AIRFLOW_BLOW = 'blasen'

const eq = (a: string | undefined, b: string) => normToken(a ?? '').trim() === normToken(b).trim()

/**
 * Does this catalogue entry's `when` hold for the symbol as placed?
 *
 * One clause is an AND over its fields; a LIST of clauses is an OR over the clauses. The OR is
 * what «Typ = Exhauster oder Luftrichtung = saugen» needs — a Lüfter switched to saugen is an
 * Exhauster whether or not anybody also set its Typ.
 */
function whenHolds(when: Record<string, string> | Record<string, string>[] | undefined, m: SymbolMatch): boolean {
  if (!when) return false
  if (Array.isArray(when)) return when.some((clause) => clauseHolds(clause, m))
  return clauseHolds(when, m)
}

function clauseHolds(when: Record<string, string>, m: SymbolMatch): boolean {
  const entries = Object.entries(when)
  // an empty clause would match everything — that is a config mistake, not a wildcard
  if (!entries.length) return false
  return entries.every(([field, want]) => {
    if (eq(field, AIRFLOW_FIELD)) {
      return eq(m.extract ? AIRFLOW_EXTRACT : AIRFLOW_BLOW, want)
    }
    // a symbol's own field, matched case- and umlaut-insensitively like everything else here
    const got = Object.entries(m.fields ?? {}).find(([k]) => eq(k, field))?.[1]
    return eq(got, want)
  })
}

/**
 * The catalogue material a placed symbol corresponds to, or undefined.
 *
 * Order, most specific first:
 *   1. the symbol matches AND a `when` clause holds — «Lüfter, Typ = Exhauster» → Exhauster
 *   2. the symbol matches and the entry names no variant — the general «Lüfter»
 *   3. the loose label↔symbol-name token match, for the 1:1 cases nobody configures
 *      («Tauchpumpe» ↔ «FW Tauchpumpe»); «Leiter» still does NOT match «VKF Einsatzleiter»,
 *      because every token of the LABEL has to appear as a whole word in the symbol name.
 */
export function materialForSymbol(
  catalogue: DeploymentMittelItem[],
  symbol: string | SymbolMatch,
): DeploymentMittelItem | undefined {
  const m: SymbolMatch = typeof symbol === 'string' ? { symbol } : symbol
  const name = m.symbol.trim()
  const named = catalogue.filter((c) => c.symbol && c.symbol.trim() === name)
  return named.find((c) => whenHolds(c.when, m))
    ?? named.find((c) => !c.when)
    ?? tokenMatch(catalogue, name)
}

function tokenMatch(catalogue: DeploymentMittelItem[], symbolName: string): DeploymentMittelItem | undefined {
  const symTokens = new Set(tokens(symbolName))
  return catalogue.find((c) => {
    const t = tokens(c.label)
    return t.length > 0 && t.every((x) => symTokens.has(x))
  })
}

/**
 * Is the symbol→Mittel capture configured at all on this station?
 *
 * ⚠️ The gate is «has anybody mapped a material to a symbol», not a switch somebody has to find.
 * A station that has not thought about this never gets an offer it did not ask for — which is
 * the state that produced wrong suggestions before — and there is no setting to discover. The
 * loose token match only applies WITHIN a station that configured something, so it stays a
 * convenience rather than a source of guesses nobody asked for.
 */
export function symbolCaptureConfigured(catalogue: DeploymentMittelItem[]): boolean {
  return catalogue.some((c) => !!c.symbol)
}

/** Where a material should be booked from by default: the source its Bestand says it lives on.
 *  The biggest stock wins when it is carried in several places; undefined when the catalogue
 *  says nothing, and then the picker simply opens unset. */
export function defaultSourceFor(item: DeploymentMittelItem): string | undefined {
  const best = [...(item.stock ?? [])].sort((a, b) => (b.qty ?? 0) - (a.qty ?? 0))[0]
  return best?.source
}

