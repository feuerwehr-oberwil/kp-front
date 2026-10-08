// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Table } from './ui'

// The stacked-row layout (admin.css) hides the header row below 860px of table width, so a
// secondary cell must carry its column's name itself — or «v3» and «—» stand there unexplained.
describe('useCellLabels — every body cell is named after its column', () => {
  afterEach(() => cleanup())

  it('labels each cell with its header text, and leaves a spanning cell unnamed', () => {
    const { container } = render(
      <Table columns={[{ key: 'n', label: 'Name' }, { key: 'v', label: 'Version' }, { key: 'a', label: '' }]}>
        <tr><td>Aufgaben</td><td>v3</td><td>⋮</td></tr>
        <tr><td colSpan={3}>Fehler</td></tr>
      </Table>,
    )
    const cells = Array.from(container.querySelectorAll('tbody td'), (td) => td.getAttribute('data-label'))
    expect(cells).toEqual(['Name', 'Version', null, null])
  })
})
