// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  // Enter and «+» used to be the only commits: typing a Gast and then tapping «Trupp starten»
  // silently discarded the name — the member the operator could SEE was not in the Trupp they
  // started. The field now commits when focus leaves it, which lands before any tap's click.
  it('commits a typed name when focus leaves the field', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    const input = screen.getByLabelText('Name eingeben …')
    fireEvent.change(input, { target: { value: 'Nachbarwehr Keller' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith([{ name: 'Nachbarwehr Keller' }])
  })

  // tapping «+» blurs the field first — the blur is the commit, and the click that follows must
  // not add the same name a second time
  it('does not double-add when the blur and the «+» click race', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    const input = screen.getByLabelText('Name eingeben …')
    fireEvent.change(input, { target: { value: 'Nachbarwehr Keller' } })
    const plus = screen.getByRole('button', { name: 'Hinzufügen' })
    fireEvent.blur(input, { relatedTarget: plus })
    fireEvent.click(plus)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // …the row's own ✕ is the ONE deliberate discard: its pointerdown beats the blur, so the
  // name the operator is throwing away is not snuck into the Trupp on the way out
  it('lets the ✕ discard the typed name without the blur committing it', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    const input = screen.getByLabelText('Name eingeben …')
    fireEvent.change(input, { target: { value: 'Tippfehler' } })
    const cancel = screen.getByRole('button', { name: 'Abbrechen' })
    fireEvent.pointerDown(cancel)
    fireEvent.blur(input, { relatedTarget: cancel })
    fireEvent.click(cancel)
    expect(onChange).not.toHaveBeenCalled()
  })

  // the modal can be torn down around a still-focused field (no blur fires then) — the typed
  // Gast must reach the Trupp anyway
  it('commits a typed name on unmount', () => {
    const onChange = vi.fn<(next: Slot[]) => void>()
    const { unmount } = render(
      <TruppTeam
        value={[]} onChange={onChange} personnel={personnel} legacyRoster={[]}
        presentIds={new Set()} assignedIds={new Set()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Name eingeben/ }))
    fireEvent.change(screen.getByLabelText('Name eingeben …'), { target: { value: 'Nachbarwehr Keller' } })
    unmount()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith([{ name: 'Nachbarwehr Keller' }])
  })

  // an empty slot looks like the field it is not — the tap has to hand the caret on, or the
  // first-time user sits there waiting for a keyboard that never opens
  // …and it points at the GAST link too: whoever is not on the Mannschaft gets no answer from
  // the search field or the list, so the one control that has one must not stay dark. Highlight
  // only — the caret stays in the search field.
  it('points an empty slot at the search field, the list and the Gast link', async () => {
    setup()
    const slot = screen.getAllByTitle('Person suchen …')[0]
    expect(slot.querySelector('input')).toBe(null)
    fireEvent.click(slot)
    expect(document.activeElement).toBe(screen.getByLabelText('Person suchen …'))
    // the flash is armed a frame later (pointAtSearch restarts it even mid-blink)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Name eingeben/ }).className).toContain('linkBtnHint')
    })
    expect(screen.getByRole('listbox').className).toContain('teamListHint')
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
