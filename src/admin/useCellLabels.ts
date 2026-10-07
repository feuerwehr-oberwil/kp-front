import { useLayoutEffect, useRef } from 'react'

/** Names every body cell after its column: copies the header's own text onto each `<td>` as
 *  `data-label`. Where the table is too narrow for its columns (admin.css · «stacked rows»), the
 *  header row is hidden and each row becomes a card — the label is how a secondary value there
 *  still says what it is («Version v3», not a bare «v3»). Runs after every render of the owning
 *  component, so rows that arrive later are named too; a spanning cell is left unnamed. Only the
 *  header's direct text counts, never an ⓘ inside it.
 *  Every hand-written `.adm-table` takes it (`const ref = useCellLabels()` · `<table ref={ref}>`);
 *  ui.tsx · `Table` does it for the rest. */
export function useCellLabels() {
  const ref = useRef<HTMLTableElement>(null)
  useLayoutEffect(() => {
    const t = ref.current
    if (!t) return
    const heads = Array.from(t.querySelectorAll(':scope > thead > tr > th'), (th) =>
      Array.from(th.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim())
    for (const tr of Array.from(t.querySelectorAll(':scope > tbody > tr'))) {
      let col = 0
      for (const cell of Array.from(tr.children) as HTMLTableCellElement[]) {
        const span = cell.colSpan || 1
        const label = span === 1 ? heads[col] : ''
        if (label) cell.setAttribute('data-label', label)
        else cell.removeAttribute('data-label')
        col += span
      }
    }
  })
  return ref
}
