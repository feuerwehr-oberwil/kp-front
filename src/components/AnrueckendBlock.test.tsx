// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AnrueckendBlock } from './AnrueckendBlock'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { FIXTURE, ROSTER } from '../lib/diveraResponses.fixture'
import type { AttendanceState } from '../types'

afterEach(cleanup)

const mount = (over: Partial<Parameters<typeof AnrueckendBlock>[0]> = {}) => {
  const props = {
    incidentId: 'i1', people: ROSTER, attendance: {} as AttendanceState, canEdit: true,
    onMarkPresent: vi.fn(), initial: FIXTURE, ...over,
  }
  const view = render(<AnrueckendBlock {...props} />)
  return { props, ...view }
}

describe('«Anrückend» — the Divera answers above the crew list', () => {
  it('says the counts in one line: kommen · kommen nicht · andere', () => {
    mount()
    const R = appConfig.copy.anrueckend
    const head = screen.getByRole('button', { expanded: true })
    expect(head.textContent).toContain(`${R.coming(4)} · ${R.notComing(2)} · ${R.other(1)}`)
  })

  it('marks «kommt nicht» with the word on every row, in a group of its own — never colour alone', () => {
    mount()
    const R = appConfig.copy.anrueckend
    const group = screen.getByRole('heading', { name: R.notComingGroup(2) })
    const list = group.nextElementSibling as HTMLElement
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.textContent).toContain(R.notComingWord)
    // …and the coming ones never carry it
    expect(screen.getByText('Keller Peter').closest('li')!.textContent).not.toContain(R.notComingWord)
  })

  it('labels the arrival as an estimate («ca.») and only where the status promises minutes', () => {
    mount()
    const row = screen.getByText('Keller Peter').closest('li')!
    expect(row.textContent).toMatch(/ca\. \d\d:\d\d/)
    expect(screen.getByText('Muster Hans').closest('li')!.textContent).not.toMatch(/ca\./)
  })

  it('checks somebody in only on the explicit «da» tap — also somebody who said they would not come', () => {
    const { props } = mount()
    expect(props.onMarkPresent).not.toHaveBeenCalled()
    const R = appConfig.copy.anrueckend
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(R.checkInLabel, { name: 'Huber Lea' }) }))
    expect(props.onMarkPresent).toHaveBeenCalledWith(expect.objectContaining({ id: 'p104' }))
  })

  it('offers no «da» to a session that may not write', () => {
    mount({ canEdit: false })
    expect(screen.queryByRole('button', { name: /als anwesend erfassen/ })).toBeNull()
    expect(screen.getByText('Keller Peter')).toBeTruthy()
  })

  it('renders nothing at all when the Einsatz has no Divera answers', () => {
    const { container } = mount({ initial: { available: false } })
    expect(container.innerHTML).toBe('')
  })

  it('folds away on its head and names the unmapped answer', () => {
    mount()
    const R = appConfig.copy.anrueckend
    expect(screen.getByText((t) => t.includes(R.unmapped(1)))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('Keller Peter')).toBeNull()
  })
})
