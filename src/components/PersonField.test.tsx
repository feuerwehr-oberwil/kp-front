// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import type { Person } from '../types'
import { PersonField } from './PersonField'

afterEach(cleanup)

/** the menu's one field: a search AND the name entry (ComboMenu · custom) */
const SEARCH = appConfig.copy.combo.searchOrType
/** the row that takes what is typed — «‹X› verwenden» */
const useRow = (name: string) => new RegExp(appConfig.copy.combo.useTyped.replace('{name}', name))

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
    // the search row IS the name field — no mode switch into a bare input any more
    fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value: 'Gast Person' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: useRow('Gast Person') }))
    expect(onChange).toHaveBeenCalledWith({ name: 'Gast Person', personId: undefined })
  })
})

// A hand-typed name is how a Gast / Nachbarwehr / not-yet-synced AdF is named here. It used to
// stay a bare string on the Rapport: no id, so nothing reached the Anwesenheit — the Einsatz
// could be led by somebody who appears on no list, and on no Personalblatt printed from one.
describe('PersonField · a typed name is filed under an id', () => {
  function type(onAddGuest?: (name: string) => string | undefined, typed = 'Muster Felix') {
    const onChange = vi.fn()
    render(
      <PersonField
        label="Einsatzleiter" placeholder="Person wählen" value={{ name: '' }} onChange={onChange}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()}
        usedIds={new Set()} usedNames={new Set()} onAddGuest={onAddGuest}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Person wählen' }))
    fireEvent.change(screen.getByPlaceholderText(SEARCH), { target: { value: typed } })
    return onChange
  }

  it('hands the name to onAddGuest and keeps the id it comes back with', () => {
    const onAddGuest = vi.fn(() => 'g1')
    const onChange = type(onAddGuest)
    fireEvent.click(screen.getByRole('button', { name: useRow('Muster Felix') }))
    expect(onAddGuest).toHaveBeenCalledTimes(1)
    expect(onAddGuest).toHaveBeenCalledWith('Muster Felix')
    expect(onChange).toHaveBeenCalledWith({ name: 'Muster Felix', personId: 'g1' })
  })

  it('keeps the bare name where the session may not write', () => {
    const onChange = type(undefined)
    fireEvent.click(screen.getByRole('button', { name: useRow('Muster Felix') }))
    expect(onChange).toHaveBeenCalledWith({ name: 'Muster Felix', personId: undefined })
  })

  // the cap the bare input used to carry (maxLength) — a hand-typed name goes on the Trupp
  // card's one-line name row, and the shared search field has no cap of its own
  it('caps a hand-typed name at 40 characters', () => {
    const onChange = type(undefined, 'M'.repeat(60))
    fireEvent.click(screen.getByRole('button', { name: /verwenden/ }))
    expect(onChange).toHaveBeenCalledWith({ name: 'M'.repeat(40), personId: undefined })
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
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: 'ster 07' } })
    const hits = screen.getAllByRole('button', { name: /Muster/ })
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toContain('Muster 07')
    // …and beside the one hit, the door that would take the query itself as a name
    expect(screen.getByRole('button', { name: useRow('ster 07') })).toBeTruthy()
  })

  it('says «kein Treffer» rather than «keine Mannschaft» when a search finds nothing', () => {
    open(many)
    fireEvent.change(screen.getByLabelText(SEARCH), { target: { value: 'zzz' } })
    expect(screen.getByText('Kein Treffer')).toBeTruthy()
  })

  // ⚠️ The >8 threshold does NOT apply here: the field doubles as the name entry, so hiding it
  // on a short roster would leave nowhere at all to type a Gast (ComboMenu · searchShown).
  it('offers the search box even on a roster that already fits', () => {
    open(personnel)
    expect(screen.getByLabelText(SEARCH)).toBeTruthy()
  })
})
