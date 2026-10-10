import { newId } from './ids'
import {
  editableColumns, isLabel, isTemplatePage, labelText, shownColumns, shownFixedRows, shownSections, tableAddsRows, writtenColumns,
  type BoardTemplate, type Label, type TableSection, type TemplatePage,
} from './boardTemplate'
import type { BoardAnno } from '../types'

/**
 * A Tafel PAGE — one board-template page added to an Einsatz, with everything written on it
 * (10.10.2026; generalises the staging «Erstes Plakat», lib/plakat on feat/tafel-start).
 *
 * ⚠️ ONE board anno of kind `form` on the Tafel's own sheet (`board['tafel']`), carrying the page
 * SNAPSHOT and its values. That is the whole persistence story, on purpose: the anno rides the
 * board's write path (useBoardDoc · add / patchCommit / remove), so adding a page is one ↶ step,
 * every committed cell is one ↶ step, removing a page is one ↶ step, and it syncs, survives a
 * reload and works offline exactly like a note on the same sheet. It has no x/y/pts, so nothing
 * positional (lasso, bake onto the Karte, projection, plan print) ever sees it — the Whiteboard
 * splits it off before any of that runs (Whiteboard · formAnnos). A merge is per object, so two
 * devices on two different pages never collide; two on the same page keep the later write.
 *
 * Values are keyed by section / cell / column / row id — never by position or label — so a
 * station renaming «Wer» to «Zuständig» in its file loses nothing, and the page's own snapshot
 * (`page`) keeps an open or archived Einsatz printing exactly what it was filled in against.
 */

/** The Tafel's plan id — the one sheet that has pages (data/demoIncident · planDocuments). Here,
 *  not in lib/tafelPages: the Rapport needs it too, and this module is already where they meet. */
export const TAFEL_ID = 'tafel'

export type FormTrend = 'up' | 'same' | 'down'
/** one written line in a Problemerfassung box */
export interface FormLine { id: string; text: string; trend?: FormTrend; tag?: string }
/** one table row: the typed cells by column id (a trend column holds 'up' | 'same' | 'down').
 *  `seed` marks a row the page pre-filled (a vehicle in «Mittel») until somebody edits it. */
export interface FormRow { id: string; cells: Record<string, string>; done?: boolean; seed?: boolean }
export interface FormSectionValue {
  /** quad: lines per box id */
  lines?: Record<string, FormLine[]>
  /** table: rows — the fixed rows under their template ids, written rows after them */
  rows?: FormRow[]
  /** text: field values by field id */
  fields?: Record<string, string>
}
export interface FormHead { title?: string; address?: string; alarm?: string; el?: string }
export interface BoardFormData {
  v: 1
  /** which template, which version — the station file it came from, as it was then */
  tpl: { id: string; version: number; title: Label; source?: string }
  /** the page as it stood in that file when it was added (the snapshot) */
  page: TemplatePage
  /** when the page was added — the order of the page strip */
  at: string
  /** the optional header line (page.header) */
  head?: FormHead
  values: Record<string, FormSectionValue>
  /** when each written atom was last changed (`formAtoms` key → server ms) — what settles a
   *  cell two devices changed at once (lib/boardFormMerge): the later edit stands */
  t?: Record<string, number>
}
export type FormAnno = BoardAnno & { kind: 'form'; form: BoardFormData }

/** What the Einsatz already knows, handed in when a page is added (lib/boardSeed). */
export interface FormSeed {
  title?: string | null
  address?: string | null
  /** «11:24», already formatted */
  alarm?: string | null
  einsatzleiter?: string | null
  /** vehicle names known to the Einsatz — deduplicated here */
  vehicles?: readonly string[]
}

// ── making a page ─────────────────────────────────────────────────────────────────────────────

const dedupe = (names: readonly string[]) => {
  const seen = new Set<string>()
  return names.map((v) => v.trim()).filter((v) => {
    const k = v.toLowerCase()
    if (!v || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** A fresh page off a template: empty but for what a section asks to be seeded with. */
export function newFormPage(tpl: BoardTemplate, page: TemplatePage, seed: FormSeed = {}, at: string = new Date().toISOString()): BoardFormData {
  const values: Record<string, FormSectionValue> = {}
  const vehicles = dedupe(seed.vehicles ?? [])
  for (const s of page.sections) {
    if (s.type === 'table' && s.seed === 'vehicles' && vehicles.length && tableAddsRows(s)) {
      const first = editableColumns(s)[0]
      if (first) values[s.id] = { rows: vehicles.map((name) => ({ id: newId('fr'), cells: { [first.id]: name }, seed: true })) }
    }
  }
  return {
    v: 1,
    tpl: { id: tpl.id, version: tpl.version, title: tpl.title, ...(tpl.source ? { source: tpl.source } : {}) },
    page: JSON.parse(JSON.stringify(page)) as TemplatePage,
    at,
    ...(page.header ? { head: { title: seed.title?.trim() ?? '', address: seed.address?.trim() ?? '', alarm: seed.alarm?.trim() ?? '', el: seed.einsatzleiter?.trim() ?? '' } } : {}),
    values,
  }
}

/** The anno that carries a page. */
export const formAnno = (form: BoardFormData): FormAnno => ({ id: newId('fm'), kind: 'form', form })

/** A Tafel page this build can draw (see isFormData for why that is not «kept»). */
export const isFormAnno = (a: BoardAnno): a is FormAnno => a.kind === 'form' && isFormData(a.form)

/** The pages on a sheet, in the order they were added (the array order is the store's, not ours). */
export const findForms = (annos: readonly BoardAnno[]): FormAnno[] =>
  annos.filter(isFormAnno).sort((a, b) => a.form.at.localeCompare(b.form.at) || a.id.localeCompare(b.id))

// ── the gate a synced page passes (lib/workspace · isBoardAnno) ─────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStrMap = (v: unknown) => isObj(v) && Object.values(v).every((x) => typeof x === 'string')
const TRENDS: readonly unknown[] = ['up', 'same', 'down']
const isLine = (v: unknown) => isObj(v) && typeof v.id === 'string' && typeof v.text === 'string'
  && (v.trend === undefined || TRENDS.includes(v.trend)) && (v.tag === undefined || typeof v.tag === 'string')
const isRow = (v: unknown) => isObj(v) && typeof v.id === 'string' && isStrMap(v.cells)
  && (v.done === undefined || typeof v.done === 'boolean') && (v.seed === undefined || typeof v.seed === 'boolean')
const isSectionValue = (v: unknown) => isObj(v)
  && (v.lines === undefined || (isObj(v.lines) && Object.values(v.lines).every((ls) => Array.isArray(ls) && ls.every(isLine))))
  && (v.rows === undefined || (Array.isArray(v.rows) && v.rows.every(isRow)))
  && (v.fields === undefined || isStrMap(v.fields))

/**
 * A page this build can DRAW. ⚠️ Not the gate that decides whether it is KEPT: a page this build
 * cannot draw (a newer template feature, a value it does not know) rides through load and save
 * untouched as a passenger (lib/workspace · isPassengerAnno) — dropping it would make this
 * device's next save delete it for everybody. Deliberately structural: an unknown section type
 * or column type passes here and is merely not drawn (lib/boardTemplate · isUsableSection).
 */
export function isFormData(v: unknown): v is BoardFormData {
  if (!isObj(v) || v.v !== 1 || typeof v.at !== 'string' || !isTemplatePage(v.page)) return false
  if (v.t !== undefined && !(isObj(v.t) && Object.values(v.t).every((x) => typeof x === 'number'))) return false
  const t = v.tpl
  if (!isObj(t) || typeof t.id !== 'string' || typeof t.version !== 'number' || !isLabel(t.title)) return false
  if (v.head !== undefined && !isStrMap(v.head)) return false
  return isObj(v.values) && Object.values(v.values).every(isSectionValue)
}

// ── writing ───────────────────────────────────────────────────────────────────────────────────

/** «1124» → «11:24», «9.05» → «09:05», «7» → «07:00»; anything that is not a clock stays as typed. */
export function normalizeTime(raw: string): string {
  const s = raw.trim()
  const m = /^(\d{1,2})(?:[.:,h ]?(\d{2}))?$/.exec(s)
  if (!m) return s
  const h = Number(m[1]), min = Number(m[2] ?? '0')
  if (h > 23 || min > 59) return s
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

const sectionValue = (d: BoardFormData, sec: string): FormSectionValue => d.values[sec] ?? {}
const withSection = (d: BoardFormData, sec: string, v: FormSectionValue): BoardFormData => ({ ...d, values: { ...d.values, [sec]: v } })
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

/** A line is content when it has words — a trend or a tag on its own is not (as on staging). */
const lineIsEmpty = (l: FormLine) => !l.text.trim() && !(l.tag ?? '').trim()

/**
 * Write one line of a Problemerfassung box: patch it, append it when it is the trailing new line,
 * drop it when the patch left it without words. Hands back the SAME object for a no-op, so the
 * caller lays no empty ↶ step.
 */
export function putLine(d: BoardFormData, sec: string, cell: string, id: string, patch: Partial<Omit<FormLine, 'id'>>, at?: number): BoardFormData {
  return stamped(d, putLineRaw(d, sec, cell, id, patch), at)
}
function putLineRaw(d: BoardFormData, sec: string, cell: string, id: string, patch: Partial<Omit<FormLine, 'id'>>): BoardFormData {
  const v = sectionValue(d, sec)
  const list = v.lines?.[cell] ?? []
  const i = list.findIndex((l) => l.id === id)
  const before: FormLine = i >= 0 ? list[i] : { id, text: '' }
  const after: FormLine = { ...before, ...patch }
  for (const k of ['trend', 'tag'] as const) if (after[k] === undefined || after[k] === '') delete after[k]
  if (i >= 0 && same(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)) return d
  const empty = lineIsEmpty(after)
  if (i < 0 && empty) return d
  const next = i < 0 ? [...list, after] : empty ? list.filter((l) => l.id !== id) : list.map((l) => (l.id === id ? after : l))
  return withSection(d, sec, { ...v, lines: { ...v.lines, [cell]: next } })
}

/** The cells that decide whether a WRITTEN row is empty: every column typed there but a trend. */
const contentCols = (s: TableSection) => writtenColumns(s).filter((c) => c.type !== 'trend').map((c) => c.id)

/** Find a table section on the page snapshot. */
export const tableOf = (d: BoardFormData, sec: string): TableSection | undefined => {
  const s = d.page.sections.find((x) => x.id === sec)
  return s?.type === 'table' ? s : undefined
}

/**
 * Write one table row. A fixed row (one of the template's) is never dropped — clearing its cells
 * just leaves the printed row empty again. A written row is appended when it is the trailing new
 * row and dropped when the patch left all its typed cells empty (a tick or a trend alone is not
 * content). Empty cell values are not stored. Same-object return for a no-op.
 */
export function putRow(d: BoardFormData, sec: string, id: string, patch: { cells?: Record<string, string>; done?: boolean }, at?: number): BoardFormData {
  return stamped(d, putRowRaw(d, sec, id, patch), at)
}
function putRowRaw(d: BoardFormData, sec: string, id: string, patch: { cells?: Record<string, string>; done?: boolean }): BoardFormData {
  const s = tableOf(d, sec)
  if (!s) return d
  const v = sectionValue(d, sec)
  const list = v.rows ?? []
  const fixed = (s.fixedRows ?? []).some((r) => r.id === id)
  const i = list.findIndex((r) => r.id === id)
  const before: FormRow = i >= 0 ? list[i] : { id, cells: {} }
  const cells = { ...before.cells, ...patch.cells }
  for (const [k, x] of Object.entries(cells)) if (!x.trim()) delete cells[k]
  const after: FormRow = { ...before, cells, ...(patch.done !== undefined ? { done: patch.done } : {}) }
  if (!after.done) delete after.done
  // an edited seed row is the operator's row from now on
  if (after.seed && patch.cells && !same(before.cells, cells)) delete after.seed
  if (i >= 0 && same(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)) return d
  const empty = !contentCols(s).some((c) => (after.cells[c] ?? '').trim())
  if (fixed) {
    const bare = !Object.keys(after.cells).length && !after.done
    if (i < 0 && bare) return d
    const next = i < 0 ? [...list, after] : bare ? list.filter((r) => r.id !== id) : list.map((r) => (r.id === id ? after : r))
    return withSection(d, sec, { ...v, rows: next })
  }
  if (i < 0 && empty) return d
  const next = i < 0 ? [...list, after] : empty ? list.filter((r) => r.id !== id) : list.map((r) => (r.id === id ? after : r))
  return withSection(d, sec, { ...v, rows: next })
}

/** Write one field of a text section (an empty one is not stored). */
export function putField(d: BoardFormData, sec: string, field: string, value: string, at?: number): BoardFormData {
  const v = sectionValue(d, sec)
  const cur = v.fields?.[field] ?? ''
  if (cur === value) return d
  const fields = { ...v.fields, [field]: value }
  if (!value.trim()) delete fields[field]
  return stamped(d, withSection(d, sec, { ...v, fields }), at)
}

/** Write one header field. */
export function putHead(d: BoardFormData, key: keyof FormHead, value: string, at?: number): BoardFormData {
  if ((d.head?.[key] ?? '') === value) return d
  return stamped(d, { ...d, head: { ...d.head, [key]: value } }, at)
}

// ── atoms: the smallest things two devices can write — what a merge and the audit speak of ───

/**
 * A page flattened to its written ATOMS: `h|<key>` (header), `f|<sec>|<field>`, `l|<sec>|<box>|<line>`
 * (a whole line: text, trend, Stichwort), `r|<sec>|<row>|<col>` and `r|<sec>|<row>|#done`. An atom
 * that is not in the map is empty. Values are strings (a line as its JSON), so equality is `===`.
 */
export function formAtoms(d: BoardFormData): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(d.head ?? {})) if (typeof v === 'string' && v) out.set(`h|${k}`, v)
  for (const [sec, v] of Object.entries(d.values ?? {})) {
    if (!v || typeof v !== 'object') continue
    for (const [box, lines] of Object.entries(v.lines ?? {})) {
      for (const l of Array.isArray(lines) ? lines : []) {
        const { id, ...rest } = l
        out.set(`l|${sec}|${box}|${id}`, JSON.stringify(rest))
      }
    }
    for (const r of Array.isArray(v.rows) ? v.rows : []) {
      for (const [col, x] of Object.entries(r.cells ?? {})) if (x) out.set(`r|${sec}|${r.id}|${col}`, x)
      if (r.done) out.set(`r|${sec}|${r.id}|#done`, '1')
    }
    for (const [f, x] of Object.entries(v.fields ?? {})) if (x) out.set(`f|${sec}|${f}`, x)
  }
  return out
}

/** What changed between two versions of a page, atom by atom — the audit's `board.edit` payload
 *  (a cell, not the whole ~5 KB page) and the input of `stamped`. */
export function formDelta(a: BoardFormData, b: BoardFormData): { k: string; old?: string; new?: string }[] {
  const x = formAtoms(a), y = formAtoms(b)
  const out: { k: string; old?: string; new?: string }[] = []
  for (const k of new Set([...x.keys(), ...y.keys()])) {
    if (x.get(k) !== y.get(k)) out.push({ k, ...(x.has(k) ? { old: x.get(k) } : {}), ...(y.has(k) ? { new: y.get(k) } : {}) })
  }
  return out
}

/** `next` with the edit time of every atom it changed against `prev` — or as it is without a time. */
function stamped(prev: BoardFormData, next: BoardFormData, at: number | undefined): BoardFormData {
  if (next === prev || at == null) return next
  const t = { ...prev.t }
  for (const c of formDelta(prev, next)) t[c.k] = at
  return { ...next, t }
}

/** The rows a table shows, in order: its shown fixed rows (written or not), then the written rows. */
export function tableRows(d: BoardFormData, s: TableSection): FormRow[] {
  const rows = d.values[s.id]?.rows ?? []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const fixedIds = new Set((s.fixedRows ?? []).map((r) => r.id))
  return [
    ...shownFixedRows(s).map((r) => byId.get(r.id) ?? { id: r.id, cells: {} }),
    ...rows.filter((r) => !fixedIds.has(r.id)),
  ]
}

/** ➚ → = → ➘ → (none) → ➚ — one tap per step, the order the sheet reads them. */
export function nextTrend(t: string | undefined): FormTrend | undefined {
  return !t ? 'up' : t === 'up' ? 'same' : t === 'same' ? 'down' : undefined
}

/** Anything written by a hand beyond what the page put there itself? (asks before removing) */
export function formHasContent(d: BoardFormData): boolean {
  if (d.head && Object.values(d.head).some((x) => (x ?? '').trim()) && !d.page.header) return true
  return Object.values(d.values).some((v) =>
    Object.values(v.lines ?? {}).some((ls) => ls.length > 0)
    || (v.rows ?? []).some((r) => !r.seed)
    || Object.values(v.fields ?? {}).some((x) => x.trim()))
}

// ── the Rapport ───────────────────────────────────────────────────────────────────────────────

/** Trend words for the paper: Helvetica has no ➚ ➘ (the staging Plakat's lesson). */
export interface TrendWords { up: string; same: string; down: string }

/**
 * One page, resolved for the server (backend · report_pdf · BoardPageIn): every label in the
 * deployment's language, every row as the strings that print, in the layout's order. The server
 * draws the paper; it never has to know a template.
 */
export function formForPdf(d: BoardFormData, words: TrendWords, locale?: string, headLabels?: Record<'title' | 'address' | 'alarm' | 'el', string>): Record<string, unknown> {
  const L = (l: Label | undefined) => labelText(l, locale)
  const trendWord = (t: string | undefined) => (t === 'up' ? words.up : t === 'same' ? words.same : t === 'down' ? words.down : '')
  const p = d.page
  return {
    title: L(p.title),
    source: d.tpl.source ?? '',
    landscape: p.paper === 'landscape',
    columns: p.columns ?? 1,
    // the header line's labels travel in the deployment's words (the server prints no German of its own here)
    head: p.header ? (['title', 'address', 'alarm', 'el'] as const).map((k) => ({ label: headLabels?.[k] ?? k, value: d.head?.[k] ?? '' })) : [],
    sections: shownSections(p).map((s) => {
      const base = { id: s.id, type: s.type, title: L(s.title), subtitle: L(s.subtitle), span: s.span ?? 1, height: s.height ?? 0 }
      const v = d.values[s.id] ?? {}
      if (s.type === 'quad') {
        return {
          ...base, trend: !!s.trend, tag: !!s.tag,
          cells: s.cells.map((c) => ({
            label: L(c.label),
            lines: (v.lines?.[c.id] ?? []).map((l) => ({ text: l.text, trend: s.trend ? trendWord(l.trend) : '', tag: s.tag ? l.tag ?? '' : '' })),
          })),
        }
      }
      if (s.type === 'table') {
        const cols = shownColumns(s)
        const fixed = new Map((s.fixedRows ?? []).map((r) => [r.id, r]))
        return {
          ...base, done: !!s.done, adds: tableAddsRows(s),
          columns: cols.map((c) => ({ label: L(c.label), kind: c.type ?? 'text', w: c.w ?? 1 })),
          rows: tableRows(d, s).map((r) => ({
            fixed: fixed.has(r.id),
            done: !!r.done,
            cells: cols.map((c) => {
              if (c.fixed && fixed.has(r.id)) {
                const x = fixed.get(r.id)?.cells[c.id]
                return c.type === 'symbol' ? (typeof x === 'string' ? x : L(x)) : L(x)
              }
              const x = r.cells[c.id] ?? ''
              return c.type === 'trend' ? trendWord(x) : x
            }),
          })),
        }
      }
      if (s.type === 'text') {
        return { ...base, layout: s.layout ?? (s.fields.length > 1 ? 'row' : 'stack'), fields: s.fields.map((f) => ({ label: L(f.label), tone: f.tone ?? '', value: v.fields?.[f.id] ?? '' })) }
      }
      return base
    }),
  }
}
