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
 * emptied row is dropped), and the id of the row after it is still the right target. `NEW` names
 * whatever trailing empty row the list has AFTER the commit — the component resolves it once the
 * render has landed. The trailing row the cursor is in is named by its own id (`newId`), which it
 * keeps when the commit makes it real.
 */

/** the trailing empty line / row of a list */
export const NEW = '+new'

export type NavSection =
  /** boxes row-major; `lines` = the written line ids; `newId` = the id the trailing empty line
   *  wears right now (it keeps it when it becomes a real line, so «the same row» stays findable) */
  | { kind: 'quad'; id: string; boxes: { id: string; lines: string[]; newId?: string }[] }
  /** `rows` = every row shown (fixed and written); `adds` = a trailing empty row follows them */
  | { kind: 'table'; id: string; cols: string[]; rows: string[]; adds: boolean; newId?: string }
  | { kind: 'text'; id: string; fields: string[] }

/** where the cursor is: quad → box + row (a line id or NEW); table → row + col; text → col */
export interface NavAt { sec: string; box?: string; row?: string; col?: string }

export type NavKey = 'enter' | 'tab' | 'shift-tab'

/** null = stay where you are; 'blur' = there is nothing further, let go of the keyboard */
export type NavTarget = NavAt | 'blur' | null

const has = (s: NavSection) => s.kind === 'quad' ? s.boxes.length > 0
  : s.kind === 'table' ? s.cols.length > 0 && (s.rows.length > 0 || s.adds)
    : s.fields.length > 0

function first(s: NavSection): NavAt {
  if (s.kind === 'quad') return { sec: s.id, box: s.boxes[0].id, row: s.boxes[0].lines[0] ?? NEW }
  if (s.kind === 'table') return { sec: s.id, row: s.rows[0] ?? NEW, col: s.cols[0] }
  return { sec: s.id, col: s.fields[0] }
}

function last(s: NavSection): NavAt {
  if (s.kind === 'quad') { const b = s.boxes[s.boxes.length - 1]; return { sec: s.id, box: b.id, row: NEW } }
  if (s.kind === 'table') return { sec: s.id, row: s.adds ? NEW : s.rows[s.rows.length - 1], col: s.cols[s.cols.length - 1] }
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
    const isNew = at.row === NEW || (!!box.newId && at.row === box.newId)
    const idx = isNew ? box.lines.length : box.lines.indexOf(at.row ?? '')
    if (key === 'enter') {
      if (isNew) return emptyAfter ? nextSection(layout, i) : { sec: s.id, box: box.id, row: NEW }
      return { sec: s.id, box: box.id, row: box.lines[idx + 1] ?? NEW }
    }
    const to = back ? b - 1 : b + 1
    if (to < 0) return prevSection(layout, i)
    if (to >= s.boxes.length) return nextSection(layout, i)
    const target = s.boxes[to]
    // the same line in the neighbouring box, or its empty line when it has fewer
    return { sec: s.id, box: target.id, row: target.lines[Math.max(0, idx)] ?? NEW }
  }

  // table
  const c = s.cols.indexOf(at.col ?? '')
  const isNew = at.row === NEW || (!!s.newId && at.row === s.newId)
  const r = isNew ? s.rows.length : s.rows.indexOf(at.row ?? '')
  const below = (): NavTarget => {
    if (isNew) return emptyAfter ? nextSection(layout, i) : { sec: s.id, row: NEW, col: s.cols[0] }
    const next = s.rows[r + 1]
    if (next) return { sec: s.id, row: next, col: s.cols[0] }
    return s.adds ? { sec: s.id, row: NEW, col: s.cols[0] } : nextSection(layout, i)
  }
  if (key === 'enter') {
    // the trailing row just became a real one: the NEXT trailing row, same column
    if (isNew) return emptyAfter ? nextSection(layout, i) : { sec: s.id, row: NEW, col: at.col }
    const next = s.rows[r + 1]
    if (next) return { sec: s.id, row: next, col: at.col }
    return s.adds ? { sec: s.id, row: NEW, col: at.col } : nextSection(layout, i)
  }
  // across inside the row: the row keeps its id (a trailing row that becomes real on this very
  // commit too), so the target names it, never NEW — NEW would be the NEXT empty row
  if (!back) {
    if (c + 1 < s.cols.length) return { sec: s.id, row: at.row, col: s.cols[c + 1] }
    // the last column of an empty trailing row: nothing below to wrap to but the next section
    if (isNew && emptyAfter) return nextSection(layout, i)
    return below()
  }
  if (c > 0) return { sec: s.id, row: at.row, col: s.cols[c - 1] }
  const above = r - 1
  if (above >= 0) return { sec: s.id, row: s.rows[above], col: s.cols[s.cols.length - 1] }
  return prevSection(layout, i)
}
