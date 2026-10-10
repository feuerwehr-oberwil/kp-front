import { getLocaleId } from '../config/copy'

/**
 * Board templates (`board-template/1`, 10.10.2026) — the paper forms the Tafel offers as pages
 * beside its free «Skizze»: the FKS «Erste Führung» poster and the FKS Handbuch sheets.
 *
 * ⚠️ This file is the CLIENT half of a contract the backend owns: `backend/app/board_templates.py`
 * is the pydantic model (`extra="forbid"`), `docs/board-template.schema.json` is its schema (a
 * pytest fails when they drift), and `docs/board-templates.md` is how a station writes one. The
 * shape check here (`isBoardTemplate`) is the gate a template passes before the Tafel draws it —
 * deliberately STRUCTURAL and tolerant of keys it does not know, so a newer station file never
 * blanks an older client; the backend refuses unknown keys at the door instead.
 *
 * What it describes is layout and labels ONLY. Entered data is keyed by the section, cell,
 * column and row ids in here (lib/boardForm), so a station that renames a label never loses a
 * word, and a page added to an Einsatz carries its own copy of the page (the SNAPSHOT), so a
 * later edit to the station file never changes an open or archived Einsatz or its Rapport.
 */

export const BOARD_TEMPLATE_SCHEMA = 'board-template/1'

/** A label: one string for every language, or one per language (German is the fallback). */
export type Label = string | { de: string; fr?: string; it?: string; en?: string }

/** text = free text · time = «Wann» (1124 → 11:24) · trend = ➚ = ➘ · symbol = a printed
 *  Signatur (lib/boardSignatures, fixed only) · index = the printed number of a fixed row */
export type ColumnType = 'text' | 'time' | 'trend' | 'symbol' | 'index'

export interface TemplateColumn {
  id: string
  label: Label
  type?: ColumnType
  /** pre-printed: the value comes from the row (`fixedRows[].cells`), never typed */
  fixed?: boolean
  /** relative width (default 1) */
  w?: number
  hidden?: boolean
}

/** A pre-printed row (the six Absprachepunkte, the Rapport Traktanden): its fixed cells. */
export interface TemplateRow {
  id: string
  cells: Record<string, Label>
  hidden?: boolean
}

export interface TemplateField {
  id: string
  label?: Label
  /** plus / minus = the green / red Variante boxes, shade = the grey «given» box */
  tone?: 'plus' | 'minus' | 'shade'
  type?: 'text' | 'time'
}

interface SectionBase {
  id: string
  title?: Label
  subtitle?: Label
  /** grid columns the section spans on a two-column page */
  span?: 1 | 2
  /** height on paper, in ruled rows (also the row count a table prints empty) */
  height?: number
  hidden?: boolean
}

export interface QuadSection extends SectionBase {
  type: 'quad'
  /** the four (or two) boxes, row-major: Front · Ordnung / Sanität · Spezialprobleme */
  cells: { id: string; label: Label }[]
  /** station switch: a ➚ = ➘ per line (FKS 8.1's Entwicklungstendenz) — off in the FKS poster */
  trend?: boolean
  /** station switch: a «Stichwort» per line — off in the FKS poster */
  tag?: boolean
}
export interface MapSection extends SectionBase {
  type: 'map'
}
export interface TableSection extends SectionBase {
  type: 'table'
  columns: TemplateColumn[]
  fixedRows?: TemplateRow[]
  /** may rows be written below the fixed ones (default: yes unless the table has fixed rows) */
  addRows?: boolean
  /** pre-fill when the page is added: `vehicles` = the vehicles the Einsatz already knows */
  seed?: 'vehicles'
  /** station switch: an «Erledigt» tick per row — off in the FKS poster */
  done?: boolean
}
export interface TextSection extends SectionBase {
  type: 'text'
  fields: TemplateField[]
  /** stack = one under the other · row = side by side · split = the first on top, the rest
   *  side by side under it (the Konzept's Variante with its + and –) */
  layout?: 'stack' | 'row' | 'split'
}
export type TemplateSection = QuadSection | MapSection | TableSection | TextSection

export interface TemplatePage {
  id: string
  title: Label
  /** the FKS sheet number («8.1»), shown in the «+ Seite» list */
  code?: string
  paper?: 'portrait' | 'landscape'
  columns?: 1 | 2
  /** station switch: the header line Einsatz · Adresse · Alarm · Einsatzleiter — off in FKS */
  header?: boolean
  /** station switch: not offered under «+ Seite» */
  hidden?: boolean
  sections: TemplateSection[]
}

export interface BoardTemplate {
  schema: typeof BOARD_TEMPLATE_SCHEMA
  id: string
  version: number
  title: Label
  source?: string
  pages: TemplatePage[]
}

/** The words of a label in the deployment's language (German when that one is missing). */
export function labelText(l: Label | undefined, locale: string = getLocaleId()): string {
  if (l == null) return ''
  if (typeof l === 'string') return l
  const k = locale.split('-')[0]!.toLowerCase() as 'de' | 'fr' | 'it' | 'en'
  return l[k] ?? l.de
}

// ── the shape check ───────────────────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9-]*$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && v.length <= 64
export const isLabel = (v: unknown): v is Label =>
  typeof v === 'string' || (isObj(v) && typeof v.de === 'string' && ['fr', 'it', 'en'].every((k) => v[k] === undefined || typeof v[k] === 'string'))
const optLabel = (v: unknown) => v === undefined || isLabel(v)
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean'
const uniqueIds = (xs: { id: string }[]) => new Set(xs.map((x) => x.id)).size === xs.length
const COLUMN_TYPES: readonly string[] = ['text', 'time', 'trend', 'symbol', 'index']

function isColumn(v: unknown): v is TemplateColumn {
  return isObj(v) && isId(v.id) && isLabel(v.label)
    && (v.type === undefined || COLUMN_TYPES.includes(v.type as string))
    && optBool(v.fixed) && optBool(v.hidden)
    && (v.w === undefined || (typeof v.w === 'number' && v.w > 0 && v.w <= 20))
}

function isSection(v: unknown): v is TemplateSection {
  if (!isObj(v) || !isId(v.id) || !optLabel(v.title) || !optLabel(v.subtitle) || !optBool(v.hidden)) return false
  if (v.span !== undefined && v.span !== 1 && v.span !== 2) return false
  if (v.height !== undefined && !(typeof v.height === 'number' && v.height >= 1 && v.height <= 60)) return false
  switch (v.type) {
    case 'quad':
      return Array.isArray(v.cells) && v.cells.length >= 1 && v.cells.length <= 4
        && v.cells.every((c) => isObj(c) && isId(c.id) && isLabel(c.label)) && uniqueIds(v.cells as { id: string }[])
        && optBool(v.trend) && optBool(v.tag)
    case 'map':
      return true
    case 'table': {
      if (!Array.isArray(v.columns) || v.columns.length < 1 || !v.columns.every(isColumn) || !uniqueIds(v.columns as TemplateColumn[])) return false
      const cols = v.columns as TemplateColumn[]
      // a table nobody can write into is a picture, not a form
      if (!cols.some((c) => !c.fixed)) return false
      if (v.fixedRows !== undefined) {
        if (!Array.isArray(v.fixedRows) || !uniqueIds(v.fixedRows as TemplateRow[])) return false
        const fixedIds = new Set(cols.filter((c) => c.fixed).map((c) => c.id))
        if (!v.fixedRows.every((r) => isObj(r) && isId(r.id) && optBool(r.hidden) && isObj(r.cells)
          && Object.entries(r.cells).every(([k, x]) => fixedIds.has(k) && isLabel(x)))) return false
      }
      return optBool(v.addRows) && optBool(v.done) && (v.seed === undefined || v.seed === 'vehicles')
    }
    case 'text':
      return Array.isArray(v.fields) && v.fields.length >= 1 && v.fields.length <= 6
        && v.fields.every((f) => isObj(f) && isId(f.id) && optLabel(f.label)
          && (f.tone === undefined || f.tone === 'plus' || f.tone === 'minus' || f.tone === 'shade')
          && (f.type === undefined || f.type === 'text' || f.type === 'time'))
        && uniqueIds(v.fields as TemplateField[])
        && (v.layout === undefined || v.layout === 'stack' || v.layout === 'row' || v.layout === 'split')
    default:
      return false
  }
}

/** One page — also the gate the SNAPSHOT inside a synced Tafel page passes (lib/boardForm). */
export function isTemplatePage(v: unknown): v is TemplatePage {
  return isObj(v) && isId(v.id) && isLabel(v.title)
    && (v.code === undefined || typeof v.code === 'string')
    && (v.paper === undefined || v.paper === 'portrait' || v.paper === 'landscape')
    && (v.columns === undefined || v.columns === 1 || v.columns === 2)
    && optBool(v.header) && optBool(v.hidden)
    && Array.isArray(v.sections) && v.sections.length >= 1 && v.sections.every(isSection)
    && uniqueIds(v.sections as TemplateSection[])
}

/** A whole `board-template/1` file. */
export function isBoardTemplate(v: unknown): v is BoardTemplate {
  return isObj(v) && v.schema === BOARD_TEMPLATE_SCHEMA && isId(v.id)
    && typeof v.version === 'number' && Number.isInteger(v.version) && v.version >= 1
    && isLabel(v.title) && (v.source === undefined || typeof v.source === 'string')
    && Array.isArray(v.pages) && v.pages.length >= 1 && v.pages.every(isTemplatePage)
    && uniqueIds(v.pages as TemplatePage[])
}

// ── reading a page ────────────────────────────────────────────────────────────────────────────

/** What a page shows: its sections without the ones a station switched off. */
export const shownSections = (p: TemplatePage): TemplateSection[] => p.sections.filter((s) => !s.hidden)
export const shownColumns = (s: TableSection): TemplateColumn[] => s.columns.filter((c) => !c.hidden)
export const shownFixedRows = (s: TableSection): TemplateRow[] => (s.fixedRows ?? []).filter((r) => !r.hidden)
/** the columns somebody types into */
export const editableColumns = (s: TableSection): TemplateColumn[] => shownColumns(s).filter((c) => !c.fixed)
/** a table with pre-printed rows is a fixed list unless it says otherwise */
export const tableAddsRows = (s: TableSection): boolean => s.addRows ?? !(s.fixedRows?.length)

/** The pages one template offers under «+ Seite», in its order. */
export const offeredPages = (t: BoardTemplate): TemplatePage[] => t.pages.filter((p) => !p.hidden)
