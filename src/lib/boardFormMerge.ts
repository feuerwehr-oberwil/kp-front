import { formAtoms, type BoardFormData, type FormLine, type FormRow, type FormSectionValue } from './boardForm'
import { labelText, type TemplateSection } from './boardTemplate'

/**
 * Two devices wrote on the same Tafel page at once (review of #338, 10.10.2026). A page is ONE
 * object in the workspace, and the object merge is whole-object last-writer-wins — so one
 * device's Massnahme vanished under the other's Verbindung. This merges a page ATOM by atom
 * (lib/boardForm · formAtoms: a header field, a text field, a whole problem line, a table cell, a
 * row's tick), three ways against the common ancestor:
 *
 * - only one side changed an atom → that change stands (different cells: both survive);
 * - both changed it to the same value → nothing to settle;
 * - both changed it differently → the LATER edit stands (`t`, the server-clock time each device
 *   stamped when it committed the cell), mine on a tie — and the divergence is REPORTED, so the
 *   caller writes a Verlauf row like the other merge conflicts. An emptied cell or a removed line
 *   is an edit like any other here: the later one wins, nothing is dropped silently.
 *
 * Everything that is not an atom — the page snapshot, the template identity, `at`, keys this
 * build does not know — comes from `mine`, which is how the object merge treats them too.
 */

export interface FormConflict {
  /** the atom (formAtoms key) */
  atom: string
  /** «Massnahmen · Wer» — where on the page, in the deployment's words */
  where: string
  kept: string
  lost: string
}

const parseLine = (v: string, id: string): FormLine => ({ id, ...(JSON.parse(v) as Omit<FormLine, 'id'>) })
const lineText = (v: string | undefined) => (v ? (JSON.parse(v) as { text?: string }).text ?? '' : '')

/** Where an atom is on the page, for the Verlauf row. */
function atomLabel(d: BoardFormData, atom: string): string {
  const [kind, sec, a, b] = atom.split('|')
  if (kind === 'h') return a ?? ''
  const s = d.page.sections.find((x) => x.id === sec) as TemplateSection | undefined
  const title = labelText(s?.title) || sec
  if (!s) return title
  if (kind === 'l' && s.type === 'quad') return `${title} · ${labelText(s.cells.find((c) => c.id === a)?.label) || a}`
  if (kind === 'r' && s.type === 'table') return b === '#done' ? title : `${title} · ${labelText(s.columns.find((c) => c.id === b)?.label) || b}`
  if (kind === 'f' && s.type === 'text') return labelText(s.fields.find((f) => f.id === a)?.label) || title
  return title
}

/** The three-way merge of one page (see the header). `onConflict` hears each true divergence. */
export function mergeFormData(
  base: BoardFormData,
  mine: BoardFormData,
  theirs: BoardFormData,
  onConflict?: (c: FormConflict) => void,
): BoardFormData {
  const b = formAtoms(base), m = formAtoms(mine), th = formAtoms(theirs)
  const tm = mine.t ?? {}, tt = theirs.t ?? {}
  const merged = new Map<string, string>()
  for (const k of new Set([...b.keys(), ...m.keys(), ...th.keys()])) {
    const bv = b.get(k), mv = m.get(k), tv = th.get(k)
    let out: string | undefined
    if (mv === bv) out = tv
    else if (tv === bv || mv === tv) out = mv
    else {
      const mineLater = (tm[k] ?? 0) >= (tt[k] ?? 0)
      out = mineLater ? mv : tv
      const show = (v: string | undefined) => (k.startsWith('l|') ? lineText(v) : k.endsWith('|#done') ? (v ? '✓' : '') : v ?? '')
      onConflict?.({ atom: k, where: atomLabel(mine, k), kept: show(mineLater ? mv : tv), lost: show(mineLater ? tv : mv) })
    }
    if (out !== undefined) merged.set(k, out)
  }

  // rebuild the values: every section either side holds, lists in the server's order first
  const values: Record<string, FormSectionValue> = {}
  const secIds = new Set([...Object.keys(theirs.values ?? {}), ...Object.keys(mine.values ?? {})])
  for (const sec of secIds) {
    const mv = mine.values?.[sec] ?? {}, tv = theirs.values?.[sec] ?? {}
    // keys of a section value this build does not know ride with mine
    const out: FormSectionValue = { ...tv, ...mv }
    // lines, box by box
    const boxes = new Set([...Object.keys(tv.lines ?? {}), ...Object.keys(mv.lines ?? {})])
    if (boxes.size) {
      const lines: Record<string, FormLine[]> = {}
      for (const box of boxes) {
        const order = [...(tv.lines?.[box] ?? []), ...(mv.lines?.[box] ?? [])].map((l) => l.id)
        const seen = new Set<string>()
        lines[box] = order.flatMap((id) => {
          if (seen.has(id)) return []
          seen.add(id)
          const v = merged.get(`l|${sec}|${box}|${id}`)
          return v === undefined ? [] : [parseLine(v, id)]
        })
      }
      out.lines = lines
    }
    // rows: a row is there while any of its atoms is, or while it is a seed row nobody touched
    if (tv.rows || mv.rows) {
      const byId = new Map<string, FormRow>()
      for (const r of [...(tv.rows ?? []), ...(mv.rows ?? [])]) if (!byId.has(r.id)) byId.set(r.id, r)
      const mineById = new Map((mv.rows ?? []).map((r) => [r.id, r]))
      const rows: FormRow[] = []
      for (const [id, r] of byId) {
        const cells: Record<string, string> = {}
        let done = false
        for (const [k, v] of merged) {
          const prefix = `r|${sec}|${id}|`
          if (!k.startsWith(prefix)) continue
          const col = k.slice(prefix.length)
          if (col === '#done') done = true
          else cells[col] = v
        }
        if (!Object.keys(cells).length && !done) continue
        const row: FormRow = { ...(mineById.get(id) ?? r), cells }
        if (done) row.done = true
        else delete row.done
        rows.push(row)
      }
      out.rows = rows
    }
    // text fields
    if (tv.fields || mv.fields) {
      const fields: Record<string, string> = {}
      for (const [k, v] of merged) {
        const prefix = `f|${sec}|`
        if (k.startsWith(prefix)) fields[k.slice(prefix.length)] = v
      }
      out.fields = fields
    }
    values[sec] = out
  }

  const head: Record<string, string> = {}
  for (const [k, v] of merged) if (k.startsWith('h|')) head[k.slice(2)] = v
  const t: Record<string, number> = { ...tt }
  for (const [k, x] of Object.entries(tm)) t[k] = Math.max(x, t[k] ?? 0)
  return {
    ...mine,
    ...(mine.head || theirs.head || Object.keys(head).length ? { head } : {}),
    values,
    ...(Object.keys(t).length ? { t } : {}),
  }
}
