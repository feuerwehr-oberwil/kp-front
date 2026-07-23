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
