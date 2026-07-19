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

/** The stable identity of a "what was used, from where" line: material + unit + source. Custom
 *  (incident-local) materials/sources have no config id, so they key off their trimmed label.
 *  Unit is part of the key — the same material recorded in `Stk` and in `l` are separate lines. */
export function mittelKey(e: Pick<MittelEntry, 'materialId' | 'label' | 'unit' | 'sourceId' | 'sourceLabel'>): string {
  const m = e.materialId ?? `~${e.label.trim().toLowerCase()}`
  const u = e.unit.trim().toLowerCase()
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
  at: string
  /** id of the latest event — the one a per-row edit appends a successor to */
  entryId: string
}

/** Fold the append-only event log into the latest event per key. ISO `at` strings compare
 *  lexicographically, so the newest event wins regardless of array order (merge can reorder). */
export function deriveCurrentMittel(entries: MittelEntry[]): Map<string, CurrentMittel> {
  const out = new Map<string, CurrentMittel>()
  for (const e of entries) {
    const key = mittelKey(e)
    const prev = out.get(key)
    if (!prev || e.at >= prev.at) {
      out.set(key, {
        key, materialId: e.materialId, label: e.label, unit: e.unit,
        sourceId: e.sourceId, sourceLabel: e.sourceLabel, menge: e.menge, status: e.status, at: e.at, entryId: e.id,
      })
    }
  }
  return out
}

/** The visible lines (latest per key, tombstones with `menge === 0` dropped), stably sorted. */
export function visibleMittel(entries: MittelEntry[]): CurrentMittel[] {
  return [...deriveCurrentMittel(entries).values()]
    .filter((c) => c.menge > 0)
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
      const unit = item.unit ?? 'Stk'
      const cells = new Map<string, MittelListCell>()
      for (const st of item.stock ?? []) {
        cells.set(st.source, { sourceId: st.source, sourceLabel: srcLabel(st.source), stock: st.qty, used: 0 })
      }
      for (const c of currentAll) {
        if (c.materialId !== item.id || c.unit.trim().toLowerCase() !== unit.trim().toLowerCase()) continue
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

  const customRows = visibleMittel(entries)
    .filter((c) => !covered.has(c.key))
    .map((c): MittelListRow => ({
      key: c.key, materialId: c.materialId, label: c.label, unit: c.unit, custom: true, totalUsed: c.menge,
      cells: [{ sourceId: c.sourceId, sourceLabel: c.sourceLabel, used: c.menge, status: c.status }],
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

/** The catalogue material a placed symbol corresponds to, or undefined. */
export function materialForSymbol(catalogue: DeploymentMittelItem[], symbolName: string): DeploymentMittelItem | undefined {
  const explicit = catalogue.find((c) => c.symbol && c.symbol.trim() === symbolName.trim())
  if (explicit) return explicit
  const symTokens = new Set(tokens(symbolName))
  return catalogue.find((c) => {
    const t = tokens(c.label)
    return t.length > 0 && t.every((x) => symTokens.has(x))
  })
}

