// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Person } from '../types'
import { TruppTeam } from './TruppTeam'
import type { Slot } from './PersonField'

afterEach(cleanup)

const person = (id: string, displayName: string, rank?: string): Person => ({
  id, displayName, rank, active: true, updatedAt: '2026-08-09T00:00:00.000Z',
})

const personnel: Person[] = [
  person('p1', 'Meier Anna', 'officer'),
  person('p2', 'Huber Sarah'),
  person('p3', 'Brunner Thomas'),
  person('p4', 'Graf Stefan'),
]

function setup(value: Slot[] = [], opts: { assigned?: string[] } = {}) {
  const onChange = vi.fn<(next: Slot[]) => void>()
  render(
    <TruppTeam
      value={value}
      onChange={onChange}
      personnel={personnel}
      legacyRoster={[]}
      presentIds={new Set(['p1', 'p2', 'p3'])}
      assignedIds={new Set(opts.assigned ?? [])}
    />,
  )
  return onChange
}

describe('TruppTeam', () => {
  it('adds a tapped roster member, first one first', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('option', { name: /Huber Sarah/ }))
    expect(onChange).toHaveBeenCalledWith([{ name: 'Huber Sarah', personId: 'p2' }])
  })

  // The hold is the SAME action as the tap — the hand that learned «press and hold» on a node
  // handle tries it here too. What must not happen is the trailing click landing on whoever slid
  // into that row when the crew re-ordered.
  it('crowns on a long press, and the trailing click does not crown somebody else', () => {
    vi.useFakeTimers()
    try {
      const value: Slot[] = [
        { name: 'Meier Anna', personId: 'p1' },
        { name: 'Huber Sarah', personId: 'p2' },
      ]
      const onChange = setup(value)
      const row = screen.getByRole('button', { name: 'Huber Sarah als Gruppenführer' })
      fireEvent.pointerDown(row, { clientX: 10, clientY: 10 })
      vi.advanceTimersByTime(600)
      expect(onChange).toHaveBeenCalledWith([
        { name: 'Huber Sarah', personId: 'p2' },
        { name: 'Meier Anna', personId: 'p1' },
      ])

      // …and the click the release still produces is swallowed
      onChange.mockClear()
      fireEvent.click(row)
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes the FIRST person the Gruppenführer and moves the crown on a tap', () => {
    const value: Slot[] = [
      { name: 'Meier Anna', personId: 'p1' },
      { name: 'Huber Sarah', personId: 'p2' },
    ]
    const onChange = setup(value)
    // the leader's own star states the fact and is not offered again
    expect((screen.getByRole('button', { name: 'Gruppenführer' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Huber Sarah als Gruppenführer/ }))
    expect(onChange).toHaveBeenCalledWith([
      { name: 'Huber Sarah', personId: 'p2' },
      { name: 'Meier Anna', personId: 'p1' },
    ])
  })

  it('searches the Mannschaft instead of making it a scroll list', () => {
    setup()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    fireEvent.change(screen.getByPlaceholderText('Person suchen …'), { target: { value: 'bru' } })
    const hits = screen.getAllByRole('option')
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toContain('Brunner Thomas')
  })

  it('shows somebody already in another Trupp, but does not offer them', () => {
    setup([], { assigned: ['p3'] })
    const taken = screen.getByRole('option', { name: /Brunner Thomas/ }) as HTMLButtonElement
    expect(taken.disabled).toBe(true)
    expect(taken.textContent).toContain('in einem Trupp')
  })

  it('keeps a typed name for a guest, without a roster link', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    const input = screen.getByLabelText('Name eingeben …')
    fireEvent.change(input, { target: { value: 'Nachbarwehr Keller' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([{ name: 'Nachbarwehr Keller' }])
  })

  // an empty slot looks like the field it is not — the tap has to hand the caret on, or the
  // first-time user sits there waiting for a keyboard that never opens
  it('points an empty slot at the search field instead of becoming one', () => {
    setup()
    const slot = screen.getAllByTitle('Person suchen …')[0]
    expect(slot.querySelector('input')).toBe(null)
    fireEvent.click(slot)
    expect(document.activeElement).toBe(screen.getByLabelText('Person suchen …'))
  })

  it('drops a member without touching the rest of the order', () => {
    const value: Slot[] = [
      { name: 'Meier Anna', personId: 'p1' },
      { name: 'Huber Sarah', personId: 'p2' },
      { name: 'Brunner Thomas', personId: 'p3' },
    ]
    const onChange = setup(value)
    fireEvent.click(screen.getByRole('button', { name: /Huber Sarah aus dem Trupp nehmen/ }))
    expect(onChange).toHaveBeenCalledWith([
      { name: 'Meier Anna', personId: 'p1' },
      { name: 'Brunner Thomas', personId: 'p3' },
    ])
  })
})
