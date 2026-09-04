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
    // one hit, plus the Gast row every non-empty query grows at the end of the list (see below)
    const hits = screen.getAllByRole('option')
    expect(hits).toHaveLength(2)
    expect(hits[0].textContent).toContain('Brunner Thomas')
    expect(hits[1].textContent).toContain('Gast / Nachbarwehr')
  })

  it('shows somebody already in another Trupp, but does not offer them', () => {
    setup([], { assigned: ['p3'] })
    const taken = screen.getByRole('option', { name: /Brunner Thomas/ }) as HTMLButtonElement
    expect(taken.disabled).toBe(true)
    expect(taken.textContent).toContain('in einem Trupp')
  })

  /* ── The Gast door (04.09.) ─────────────────────────────────────────────────────────────────
   * There is no «Name eingeben (Gast / Nachbarwehr)» row any more, and no second input behind it.
   * The SEARCH is the name entry, and the list grows one action row for whatever is typed. What
   * this buys is reachability: the old link closed the block BELOW the roster, so the one case
   * the Mannschaft cannot answer was the case whose answer sat furthest away.
   */
  const guestRow = (name: string) =>
    screen.getByRole('option', { name: `«${name}» als Gast / Nachbarwehr hinzufügen` })

  it('offers the Gast row only once something is typed, and takes the name from the search', () => {
    const onChange = setup()
    // at rest the list is the Mannschaft and nothing else — no permanent Gast row
    expect(screen.getAllByRole('option')).toHaveLength(personnel.length)
    expect(screen.queryByRole('option', { name: /Gast \/ Nachbarwehr/ })).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Person suchen …'), { target: { value: 'Nachbarwehr Keller' } })
    fireEvent.click(guestRow('Nachbarwehr Keller'))
    expect(onChange).toHaveBeenCalledWith([{ name: 'Nachbarwehr Keller' }])
  })

  // …and it disappears again with the query, rather than standing over a roster that has the
  // person on it: an empty search is «show me everybody», not «I am about to type a stranger».
  it('drops the Gast row again when the query is cleared', () => {
    setup()
    const search = screen.getByPlaceholderText('Person suchen …')
    fireEvent.change(search, { target: { value: 'Kel' } })
    expect(guestRow('Kel')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.queryByRole('option', { name: /Gast \/ Nachbarwehr/ })).toBeNull()
  })

  /* Enter keeps the keyboard flow one step and never has to be aimed: with matches on screen it
   * takes the first one that can be taken; with NO matches the query can only have been a name. */
  it('picks the first match on Enter while the Mannschaft still has one', () => {
    const onChange = setup()
    const search = screen.getByPlaceholderText('Person suchen …')
    fireEvent.change(search, { target: { value: 'bru' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([{ name: 'Brunner Thomas', personId: 'p3' }])
  })

  it('commits the Gast on Enter when nothing matches', () => {
    const onChange = setup()
    const search = screen.getByPlaceholderText('Person suchen …')
    fireEvent.change(search, { target: { value: 'Nachbarwehr Keller' } })
    expect(screen.queryAllByRole('option', { name: /Meier|Huber|Brunner|Graf/ })).toHaveLength(0)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([{ name: 'Nachbarwehr Keller' }])
  })

  /* ⚠️ THE REVERSAL the shared field pays for (04.09.). The old dedicated name field committed on
   * blur and on unmount, because a name typed there could only ever have been a name and dropping
   * it silently left the member the operator could SEE out of the Trupp they started. This field
   * is a search first: a half-typed «Hub» is a query in progress, and auto-committing it would put
   * a person called «Hub» in the Trupp the moment focus moved on. The commit is explicit now — the
   * action row, or Enter with nothing left to match. */
  it('never turns a half-typed query into a member by itself', () => {
    const onChange = setup()
    const search = screen.getByPlaceholderText('Person suchen …')
    fireEvent.change(search, { target: { value: 'Hub' } })
    fireEvent.blur(search)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not commit a half-typed query on unmount either', () => {
    const onChange = vi.fn<(next: Slot[]) => void>()
    const { unmount } = render(
      <TruppTeam
        value={[]} onChange={onChange} personnel={personnel} legacyRoster={[]}
        presentIds={new Set()} assignedIds={new Set()}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Person suchen …'), { target: { value: 'Nachbarwehr Kel' } })
    unmount()
    expect(onChange).not.toHaveBeenCalled()
  })

  // the Gast reaches the Anwesenheit too, and the slot keeps the id it was filed under — that is
  // what makes the Trupp card and the Personalblatt the same person rather than two lookalikes
  it('files the Gast on the Anwesenheit and keeps the id it comes back with', () => {
    const onChange = vi.fn<(next: Slot[]) => void>()
    const onAddGuest = vi.fn(() => 'guest-7')
    render(
      <TruppTeam
        value={[]} onChange={onChange} personnel={personnel} legacyRoster={[]}
        presentIds={new Set()} assignedIds={new Set()} onAddGuest={onAddGuest}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Person suchen …'), { target: { value: 'Keller Urs' } })
    fireEvent.click(guestRow('Keller Urs'))
    expect(onAddGuest).toHaveBeenCalledWith('Keller Urs')
    expect(onChange).toHaveBeenCalledWith([{ name: 'Keller Urs', personId: 'guest-7' }])
  })

  // an empty slot looks like the field it is not — the tap has to hand the caret on, or the
  // first-time user sits there waiting for a keyboard that never opens. The LIST blinks with the
  // field: «where do I type» is not the question, «where are the names» is — and since 04.09. the
  // Gast door is a row of that same list, so the blink already covers it.
  it('points an empty slot at the search field and the list', async () => {
    setup()
    const slot = screen.getAllByTitle('Person suchen …')[0]
    expect(slot.querySelector('input')).toBe(null)
    fireEvent.click(slot)
    expect(document.activeElement).toBe(screen.getByLabelText('Person suchen …'))
    // the flash is armed a frame later (pointAtSearch restarts it even mid-blink)
    await waitFor(() => {
      expect(screen.getByRole('listbox').className).toContain('teamListHint')
    })
    expect(screen.getByLabelText('Person suchen …').closest('label')!.className).toContain('teamSearchHint')
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
