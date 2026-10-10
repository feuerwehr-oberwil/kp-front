/**
 * Moving through a Tafel page by keyboard, like a spreadsheet (owner, 10.10.2026) — the PURE half
 * (TafelFormPage owns the keys and the focus).
 *
 * - **Enter** commits and goes DOWN: the next row in the same column; in a Problemerfassung box
 *   the next line of that box — and on its last line, the box's always-present empty line, so
 *   writing problem after problem is Enter, Enter, Enter. Enter on the EMPTY trailing line/row
 *   leaves for the next section's first cell, so nobody gets stuck in a list.
 * - **Tab** goes ACROSS: the next column, the next box to the right (Front → Ordnung → Sanität →
 *   Spezialprobleme, keeping the line), wrapping to the next row and then the next section.
 *   **Shift+Tab** is the exact way back. (Shift+Enter / Alt+Enter is a line break IN the cell —
 *   the component never asks this module about those.)
 * - A text section's fields go one after the other for both.
 *
 * Rows are named by id, never by position: the row being left may vanish on this very commit (an
 * emptied row is dropped), and the id of the row after it is still the right target. A row stays
 * on the ruling it was written on (lib/boardForm · slotted), so «down» is the ruling directly
 * below — an empty ruling between written rows is a row like any other, and Enter after writing
 * the 8th goes to the 9th, never back up to the first empty one. `NEW` names
 * whatever trailing empty row the list has AFTER the commit — the component resolves it once the
 * render has landed. The trailing row the cursor is in is named by its own id (`newId`), which it
 * keeps when the commit makes it real.
 */

/** the trailing empty line / row of a list */
export const NEW = '+new'

export type NavSection =
  /** boxes row-major; `lines` = the written line ids; `newId` = the id the trailing empty line
   *  wears right now (it keeps it when it becomes a real line, so «the same row» stays findable) */
  | { kind: 'quad'; id: string; boxes: { id: string; lines: string[]; newId?: string }[]; tag?: boolean }
  /** `rows` = every row shown down to the last written one (fixed, written and the empty rulings
   *  between them); `adds` = empty rows follow: `newId` is the first of them, `free` all of them
   *  in order (the ruled empty rows below, each its own id — default just `newId`).
   *  `cols` = what is typed in a FIXED row; a written row (or an empty one) may type more —
   *  `writtenCols`, e.g. the Bezeichnung under the Abspracherapport's six (owner, round 2) */
  | { kind: 'table'; id: string; cols: string[]; rows: string[]; adds: boolean; newId?: string; free?: string[]; fixed?: string[]; writtenCols?: string[] }
  | { kind: 'text'; id: string; fields: string[] }

/** where the cursor is: quad → box + row (a line id or NEW), col `tag` on a line's Stichwort;
 *  table → row + col; text → col. A row id the section does not list is an empty row below the
 *  written ones — it is treated as the trailing one. */
export interface NavAt { sec: string; box?: string; row?: string; col?: string }

export type NavKey = 'enter' | 'tab' | 'shift-tab'

/** null = stay where you are; 'blur' = there is nothing further, let go of the keyboard */
export type NavTarget = NavAt | 'blur' | null

const has = (s: NavSection) => s.kind === 'quad' ? s.boxes.length > 0
  : s.kind === 'table' ? s.cols.length > 0 && (s.rows.length > 0 || s.adds)
    : s.fields.length > 0

/** the columns typed in a row of this table */
const colsOf = (s: Extract<NavSection, { kind: 'table' }>, row: string | undefined): string[] =>
  (row && s.fixed?.includes(row) ? s.cols : s.writtenCols ?? s.cols)

function first(s: NavSection): NavAt {
  if (s.kind === 'quad') return { sec: s.id, box: s.boxes[0].id, row: s.boxes[0].lines[0] ?? NEW }
  if (s.kind === 'table') { const row = s.rows[0] ?? NEW; return { sec: s.id, row, col: colsOf(s, row)[0] } }
  return { sec: s.id, col: s.fields[0] }
}

function last(s: NavSection): NavAt {
  if (s.kind === 'quad') { const b = s.boxes[s.boxes.length - 1]; return { sec: s.id, box: b.id, row: NEW } }
  if (s.kind === 'table') {
    const row = s.adds ? NEW : s.rows[s.rows.length - 1]
    const cols = colsOf(s, row)
    return { sec: s.id, row, col: cols[cols.length - 1] }
  }
  return { sec: s.id, col: s.fields[s.fields.length - 1] }
}

const nextSection = (layout: NavSection[], i: number): NavTarget => {
  const s = layout.slice(i + 1).find(has)
  return s ? first(s) : 'blur'
}
const prevSection = (layout: NavSection[], i: number): NavTarget => {
  const s = layout.slice(0, i).reverse().find(has)
  return s ? last(s) : null
}

/**
 * Where a key takes the cursor.
 * `emptyAfter`: the line / row the cursor is in holds nothing once this commit lands — on the
 * trailing NEW row that is «Enter on an empty trailing row», the way out of a list.
 */
export function navTarget(layout: NavSection[], at: NavAt, key: NavKey, emptyAfter: boolean): NavTarget {
  const i = layout.findIndex((s) => s.id === at.sec)
  const s = layout[i]
  if (!s) return null
  const back = key === 'shift-tab'

  if (s.kind === 'text') {
    const f = s.fields.indexOf(at.col ?? '')
    const to = back ? f - 1 : f + 1
    if (to >= 0 && to < s.fields.length) return { sec: s.id, col: s.fields[to] }
    return back ? prevSection(layout, i) : nextSection(layout, i)
  }

  if (s.kind === 'quad') {
    const b = s.boxes.findIndex((x) => x.id === at.box)
    const box = s.boxes[b]
    if (!box) return null
    const isNew = at.row === NEW || (!!box.newId && at.row === box.newId) || !box.lines.includes(at.row ?? '')
    const idx = isNew ? box.lines.length : box.lines.indexOf(at.row ?? '')
    if (key === 'enter') {
      if (isNew) return emptyAfter ? nextSection(layout, i) : { sec: s.id, box: box.id, row: NEW }
      return { sec: s.id, box: box.id, row: box.lines[idx + 1] ?? NEW }
    }
    // a written line's Stichwort sits between its text and the next box
    if (s.tag && !isNew && !back && at.col !== 'tag') return { sec: s.id, box: box.id, row: at.row, col: 'tag' }
    if (s.tag && back && at.col === 'tag') return { sec: s.id, box: box.id, row: at.row }
    const to = back ? b - 1 : b + 1
    if (to < 0) return prevSection(layout, i)
    if (to >= s.boxes.length) return nextSection(layout, i)
    const target = s.boxes[to]
    // the same line in the neighbouring box, or its empty line when it has fewer
    return { sec: s.id, box: target.id, row: target.lines[Math.max(0, idx)] ?? NEW }
  }

  // table — `seq` is every row top to bottom, the empty ones below the written ones included
  const free = s.adds ? s.free ?? (s.newId ? [s.newId] : []) : []
  const seq = [...s.rows, ...free]
  const known = at.row !== NEW && seq.includes(at.row ?? '')
  /** an empty row below the last written one (only those are «free»: Enter on one left empty
   *  leaves the list) — an unknown id is one too */
  const isNew = !known || free.includes(at.row ?? '')
  const cols = colsOf(s, isNew ? undefined : at.row)
  const c = cols.indexOf(at.col ?? '')
  const r = known ? seq.indexOf(at.row ?? '') : s.rows.length
  /** the row directly below `r`, the first empty one named NEW (it is that once rendered) */
  const down = (): string | undefined => { const n = seq[r + 1]; return n && n === s.newId ? NEW : n }
  /** the column `col` in `row`, or that row's nearest one when it does not type it */
  const cell = (row: string, col: string | undefined): NavAt => {
    const there = colsOf(s, row === NEW ? undefined : row)
    return { sec: s.id, row, col: col && there.includes(col) ? col : there[Math.min(Math.max(0, cols.indexOf(col ?? '')), there.length - 1)] }
  }
  const below = (): NavTarget => {
    if (isNew && emptyAfter) return nextSection(layout, i)
    const next = down()
    if (next) return cell(next, colsOf(s, next === NEW ? undefined : next)[0])
    return s.adds ? cell(NEW, colsOf(s, undefined)[0]) : nextSection(layout, i)
  }
  if (key === 'enter') {
    // an empty row below the list left empty: out of the list; otherwise the row directly below
    // (the row just written keeps its ruling, so «below» is the next ruling, same column)
    if (isNew && emptyAfter) return nextSection(layout, i)
    const next = down()
    if (next) return cell(next, at.col)
    return s.adds ? cell(NEW, at.col) : nextSection(layout, i)
  }
  // across inside the row: the row keeps its id (a trailing row that becomes real on this very
  // commit too), so the target names it, never NEW — NEW would be the NEXT empty row
  if (!back) {
    if (c + 1 < cols.length) return { sec: s.id, row: at.row, col: cols[c + 1] }
    // the last column of an empty trailing row: nothing below to wrap to but the next section
    if (isNew && emptyAfter) return nextSection(layout, i)
    return below()
  }
  if (c > 0) return { sec: s.id, row: at.row, col: cols[c - 1] }
  const above = seq[r - 1]
  if (r - 1 >= 0 && above) { const up = colsOf(s, isNew && free.includes(above) ? undefined : above); return { sec: s.id, row: above, col: up[up.length - 1] } }
  return prevSection(layout, i)
}
