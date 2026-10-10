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
/** one written line in a Problemerfassung box. `slot`: where in the box it was written (see
 *  `slotted` — a line stays where it was written, like on paper) */
export interface FormLine { id: string; text: string; trend?: FormTrend; tag?: string; slot?: number }
/** one table row: the typed cells by column id (a trend column holds 'up' | 'same' | 'down').
 *  `seed` marks a row the page pre-filled (a vehicle in «Mittel») until somebody edits it.
 *  `slot`: which ruling under the pre-printed rows it was written on (see `slotted`) */
export interface FormRow { id: string; cells: Record<string, string>; done?: boolean; seed?: boolean; slot?: number }
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
  /** when the page was taken off the Tafel (server ms) — a tombstone, not a deletion (re-review
   *  of #338): a device still writing on it meanwhile must be able to tell whether its writing
   *  came after the removal (lib/mergeWorkspace · resolveTactical). Kept for ↶ and that merge;
   *  never shown, printed or offered (`findForms`). */
  removedAt?: number
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
      if (first) values[s.id] = { rows: vehicles.map((name, slot) => ({ id: newId('fr'), cells: { [first.id]: name }, seed: true, slot })) }
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
  annos.filter((a): a is FormAnno => isFormAnno(a) && a.form.removedAt == null).sort((a, b) => a.form.at.localeCompare(b.form.at) || a.id.localeCompare(b.id))

// ── the gate a synced page passes (lib/workspace · isBoardAnno) ─────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStrMap = (v: unknown) => isObj(v) && Object.values(v).every((x) => typeof x === 'string')
const TRENDS: readonly unknown[] = ['up', 'same', 'down']
/** a slot is a ruling on the page: a small whole number (a runaway one would draw a mile of rows) */
const isSlot = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_SLOT)
const isLine = (v: unknown) => isObj(v) && typeof v.id === 'string' && typeof v.text === 'string'
  && (v.trend === undefined || TRENDS.includes(v.trend)) && (v.tag === undefined || typeof v.tag === 'string') && isSlot(v.slot)
const isRow = (v: unknown) => isObj(v) && typeof v.id === 'string' && isStrMap(v.cells)
  && (v.done === undefined || typeof v.done === 'boolean') && (v.seed === undefined || typeof v.seed === 'boolean') && isSlot(v.slot)
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
  if (v.removedAt !== undefined && typeof v.removedAt !== 'number') return false
  const t = v.tpl
  if (!isObj(t) || typeof t.id !== 'string' || typeof t.version !== 'number' || !isLabel(t.title)) return false
  if (v.head !== undefined && !isStrMap(v.head)) return false
  return isObj(v.values) && Object.values(v.values).every(isSectionValue)
}

// ── where a row stands: its slot ─────────────────────────────────────────────────────────────

export const MAX_SLOT = 500

/**
 * ⚠️ A written row or line STAYS WHERE IT WAS WRITTEN, like on paper (owner, staging round 2:
 * «Test 1» typed into Mittel's 8th ruling jumped up to the 4th). Each one carries its `slot` — its
 * ruling under the pre-printed rows (a table) or its line in the box (a Problemerfassung) — and
 * this lays a list out by it: index = slot, `undefined` = an empty ruling ABOVE a written one,
 * which stays (it is not «free»; only the empties after the last written one are). An item from
 * before slots (none stored) stands right after the one before it — the order it always had; two
 * that claim one slot (two devices wrote the same ruling at once) keep both, the later in the
 * list on the next free ruling below. Never an array position: a merge, an undo or a removal
 * reorders arrays, and nothing that was written may move for it.
 */
export function slotted<T extends { slot?: number }>(items: readonly T[]): (T | undefined)[] {
  const out: (T | undefined)[] = []
  let prev = -1
  for (const it of items) {
    let at = typeof it.slot === 'number' && Number.isInteger(it.slot) && it.slot >= 0 ? Math.min(it.slot, MAX_SLOT - 1) : prev + 1
    while (out[at] !== undefined) at++
    out[at] = it
    prev = at
  }
  return Array.from(out)
}

/** Every item with the slot it is laid out on, stored — so a later removal above it moves nothing
 *  (an item from before slots is pinned on its first write). Same objects where nothing changes. */
function pinSlots<T extends { slot?: number }>(items: readonly T[]): T[] {
  const at = new Map<T, number>()
  slotted(items).forEach((it, i) => { if (it) at.set(it, i) })
  return items.map((it) => (it.slot === at.get(it) ? it : { ...it, slot: at.get(it) }))
}

/** The slot a new item takes: the one it was written on, else the first ruling after the last
 *  written one (the trailing empty row). */
const newSlot = <T extends { slot?: number }>(items: readonly T[], want: number | undefined): number =>
  want != null && Number.isInteger(want) && want >= 0 && want < MAX_SLOT ? want : slotted(items).length

/** A box's lines as laid out (see `slotted`). */
export const boxLines = (d: BoardFormData, sec: string, box: string): (FormLine | undefined)[] => slotted(d.values[sec]?.lines?.[box] ?? [])

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
 * Write one line of a Problemerfassung box: patch it, add it on the line it was written on
 * (`patch.slot`, else after the last one) when it is new, drop it when the patch left it without
 * words — the lines below stay where they are (`slotted`). Hands back the SAME object for a
 * no-op, so the caller lays no empty ↶ step.
 */
export function putLine(d: BoardFormData, sec: string, cell: string, id: string, patch: Partial<Omit<FormLine, 'id'>>, at?: number): BoardFormData {
  return stamped(d, putLineRaw(d, sec, cell, id, patch), at)
}
function putLineRaw(d: BoardFormData, sec: string, cell: string, id: string, patch: Partial<Omit<FormLine, 'id'>>): BoardFormData {
  const v = sectionValue(d, sec)
  const list = v.lines?.[cell] ?? []
  const i = list.findIndex((l) => l.id === id)
  const { slot: want, ...edit } = patch
  const before: FormLine = i >= 0 ? list[i] : { id, text: '' }
  const after: FormLine = { ...before, ...edit }
  for (const k of ['trend', 'tag'] as const) if (after[k] === undefined || after[k] === '') delete after[k]
  if (i >= 0 && same(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)) return d
  const empty = lineIsEmpty(after)
  if (i < 0 && empty) return d
  const pinned = pinSlots(list)
  const next = i < 0 ? [...pinned, { ...after, slot: newSlot(list, want) }]
    : empty ? pinned.filter((l) => l.id !== id) : pinned.map((l) => (l.id === id ? { ...after, slot: l.slot } : l))
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
export function putRow(d: BoardFormData, sec: string, id: string, patch: { cells?: Record<string, string>; done?: boolean; slot?: number }, at?: number): BoardFormData {
  return stamped(d, putRowRaw(d, sec, id, patch), at)
}
function putRowRaw(d: BoardFormData, sec: string, id: string, patch: { cells?: Record<string, string>; done?: boolean; slot?: number }): BoardFormData {
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
  // a written row takes the ruling it was written on and keeps it; the rows below an emptied one
  // stay where they are (`slotted`) — only the fixed rows have no slot, they are the template's
  const fixedIds = new Set((s.fixedRows ?? []).map((r) => r.id))
  const written = list.filter((r) => !fixedIds.has(r.id))
  const pinned = new Map(pinSlots(written).map((r) => [r.id, r]))
  const keep = list.map((r) => pinned.get(r.id) ?? r)
  const next = i < 0 ? [...keep, { ...after, slot: newSlot(written, patch.slot) }]
    : empty ? keep.filter((r) => r.id !== id) : keep.map((r) => (r.id === id ? { ...after, slot: r.slot } : r))
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
        // where the line stands is not something two devices write: it is set once, when the line
        // is made (lib/boardFormMerge carries it over with the line)
        const { id, slot: _slot, ...rest } = l
        void _slot
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

/**
 * A page with an audit row's `form.delta` applied (`formDelta`, the `board.edit` payload) — what
 * the Replay scrubber folds so it shows the page as it was at that moment (re-review of #338).
 * Through the same writers an edit uses; a row's atoms go in together, so a new row is made
 * with all its cells at once. A row or line the page did not have yet goes after the last one
 * (the audit names cells, not rulings).
 */
export function applyFormDelta(d: BoardFormData, delta: readonly { k: string; old?: string; new?: string }[]): BoardFormData {
  let out = d
  const rows = new Map<string, { sec: string; row: string; cells: Record<string, string>; done?: boolean }>()
  for (const c of Array.isArray(delta) ? delta : []) {
    if (!c || typeof c.k !== 'string') continue
    const [kind, a, b, x] = c.k.split('|')
    const v = typeof c.new === 'string' ? c.new : ''
    if (kind === 'h' && a) out = putHead(out, a as keyof FormHead, v)
    else if (kind === 'f' && a && b) out = putField(out, a, b, v)
    else if (kind === 'l' && a && b && x) {
      let line: Partial<FormLine> = { text: '', tag: '' }
      if (v) { try { line = { tag: '', ...(JSON.parse(v) as Partial<FormLine>) } } catch { continue } }
      out = putLine(out, a, b, x, { text: line.text ?? '', tag: line.tag ?? '', trend: line.trend })
    } else if (kind === 'r' && a && b && x) {
      const key = `${a}|${b}`
      const r: { sec: string; row: string; cells: Record<string, string>; done?: boolean } = rows.get(key) ?? { sec: a, row: b, cells: {} }
      if (x === '#done') r.done = !!v
      else r.cells[x] = v
      rows.set(key, r)
    }
  }
  for (const r of rows.values()) out = putRow(out, r.sec, r.row, { cells: r.cells, ...(r.done !== undefined ? { done: r.done } : {}) })
  return out
}

/** `next` with the edit time of every atom it changed against `prev` — or as it is without a time. */
function stamped(prev: BoardFormData, next: BoardFormData, at: number | undefined): BoardFormData {
  if (next === prev || at == null) return next
  const t = { ...prev.t }
  for (const c of formDelta(prev, next)) t[c.k] = at
  return { ...next, t }
}

/** A table's WRITTEN rows as laid out under its fixed ones: index = slot, `undefined` = an empty
 *  ruling above a written row (see `slotted`). */
export function tableSlots(d: BoardFormData, s: TableSection): (FormRow | undefined)[] {
  const fixedIds = new Set((s.fixedRows ?? []).map((r) => r.id))
  return slotted((d.values[s.id]?.rows ?? []).filter((r) => !fixedIds.has(r.id)))
}

/** The rows a table holds, in order: its shown fixed rows (written or not), then the written rows
 *  by slot (without the empty rulings between them — `tableSlots` has those). */
export function tableRows(d: BoardFormData, s: TableSection): FormRow[] {
  const rows = d.values[s.id]?.rows ?? []
  const byId = new Map(rows.map((r) => [r.id, r]))
  return [
    ...shownFixedRows(s).map((r) => byId.get(r.id) ?? { id: r.id, cells: {} }),
    ...tableSlots(d, s).filter((r): r is FormRow => !!r),
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
            // `dir` too: the paper draws the arrow itself (Helvetica has no ➚ ➘), the word is its name
            // laid out by slot, an empty ruling above a written line printed empty — the paper
            // shows what the Tafel showed
            lines: slotted(v.lines?.[c.id] ?? []).map((l) => (l
              ? { text: l.text, trend: s.trend ? trendWord(l.trend) : '', dir: s.trend ? l.trend ?? '' : '', tag: s.tag ? l.tag ?? '' : '' }
              : { text: '', trend: '', dir: '', tag: '' })),
          })),
        }
      }
      if (s.type === 'table') {
        const cols = shownColumns(s)
        const fixed = new Map((s.fixedRows ?? []).map((r) => [r.id, r]))
        return {
          ...base, done: !!s.done, adds: tableAddsRows(s),
          columns: cols.map((c) => ({ label: L(c.label), kind: c.type ?? 'text', w: c.w ?? 1 })),
          // the fixed rows, then the written ones by slot — an empty ruling between two written
          // rows prints empty, so a row stays on the ruling it was written on (owner, round 2)
          rows: [...tableRows(d, s).filter((r) => fixed.has(r.id)), ...tableSlots(d, s).map((r) => r ?? { id: '', cells: {} })].map((r) => ({
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
