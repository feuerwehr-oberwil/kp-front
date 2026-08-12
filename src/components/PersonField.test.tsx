// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Person } from '../types'
import { PersonField } from './PersonField'

afterEach(cleanup)

const personnel: Person[] = [{
  id: 'p1',
  displayName: 'Anna Beispiel',
  rank: 'officer',
  active: true,
  updatedAt: '2026-07-23T00:00:00.000Z',
}]

function setup() {
  const onChange = vi.fn()
  render(
    <PersonField
      label="Einsatzleiter"
      placeholder="Person wählen"
      value={{ name: '' }}
      onChange={onChange}
      personnel={personnel}
      legacyRoster={[]}
      presentIds={new Set(['p1'])}
      assignedIds={new Set()}
      usedIds={new Set()}
      usedNames={new Set()}
      officerFilter
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Person wählen' }))
  return onChange
}

describe('PersonField', () => {
  it('portals its personnel menu and selects a roster member', () => {
    const onChange = setup()

    expect(screen.getByRole('listbox').parentElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: /Anna Beispiel/ }))
    expect(onChange).toHaveBeenCalledWith({ name: 'Anna Beispiel', personId: 'p1' })
  })

  it('keeps manual name entry available for people outside the roster', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    fireEvent.change(screen.getByPlaceholderText('Person wählen'), { target: { value: 'Gast Person' } })

    expect(onChange).toHaveBeenCalledWith({ name: 'Gast Person' })
  })
})

// A hand-typed name is how a Gast / Nachbarwehr / not-yet-synced AdF is named here. It used to
// stay a bare string on the Rapport: no id, so nothing reached the Anwesenheit — the Einsatz
// could be led by somebody who appears on no list, and on no Personalblatt printed from one.
describe('PersonField · a typed name is filed under an id', () => {
  function type(onAddGuest?: (name: string) => string | undefined) {
    const onChange = vi.fn()
    render(
      <PersonField
        label="Einsatzleiter" placeholder="Person wählen" value={{ name: 'Muster Felix' }} onChange={onChange}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()}
        usedIds={new Set()} usedNames={new Set()} onAddGuest={onAddGuest}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Muster Felix/ }))
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    fireEvent.blur(screen.getByDisplayValue('Muster Felix'))
    return onChange
  }

  it('hands the name to onAddGuest on blur and keeps the id it comes back with', async () => {
    vi.useFakeTimers()
    const onAddGuest = vi.fn(() => 'g1')
    const onChange = type(onAddGuest)
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()
    expect(onAddGuest).toHaveBeenCalledWith('Muster Felix')
    expect(onChange).toHaveBeenCalledWith({ name: 'Muster Felix', personId: 'g1' })
  })

  it('leaves the bare name alone where the session may not write', async () => {
    vi.useFakeTimers()
    const onChange = type(undefined)
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('PersonField · roster search', () => {
  const many: Person[] = Array.from({ length: 12 }, (_, i) => ({
    id: `x${i}`, displayName: `Muster ${String(i).padStart(2, '0')}`, active: true,
    updatedAt: '2026-08-09T00:00:00.000Z',
  }))

  function open(personnel: Person[]) {
    render(
      <PersonField
        label="Einsatzleiter" placeholder="Person wählen" value={{ name: '' }} onChange={vi.fn()}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()}
        usedIds={new Set()} usedNames={new Set()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Person wählen' }))
  }

  it('narrows a long roster by what is typed', () => {
    open(many)
    expect(screen.getAllByRole('button', { name: /Muster/ })).toHaveLength(12)
    fireEvent.change(screen.getByLabelText('Person suchen …'), { target: { value: 'ster 07' } })
    const hits = screen.getAllByRole('button', { name: /Muster/ })
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toContain('Muster 07')
  })

  it('says «kein Treffer» rather than «keine Mannschaft» when a search finds nothing', () => {
    open(many)
    fireEvent.change(screen.getByLabelText('Person suchen …'), { target: { value: 'zzz' } })
    expect(screen.getByText('Kein Treffer')).toBeTruthy()
  })

  it('offers no search box on a roster that already fits', () => {
    open(personnel)
    expect(screen.queryByLabelText('Person suchen …')).toBeNull()
  })
})
