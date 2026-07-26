// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ZeitplanView } from './ZeitplanView'
import { appConfig } from '../config/appConfig'
import type { AttendanceState, Person, Shift } from '../types'

afterEach(cleanup)

// TimeField picks its input mode from the pointer type; jsdom has no matchMedia, so pin it to
// the desktop (typing) variant — the wheel popover is TimeField's own concern, not this surface's
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const Z = appConfig.copy.zeitplan
const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
const NOW = Date.parse(T(16))

const people: Person[] = [
  { id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: T(12) },
  { id: 'p2', displayName: 'Huber Beat', active: true, updatedAt: T(12) },
]
const base = {
  people, canEdit: true, startedAt: T(12), nowMs: NOW,
  onAdd: () => {}, onSetTime: () => {}, onRemove: () => {},
}

describe('ZeitplanView', () => {
  it('teaches what the surface is for while nothing is planned', () => {
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} />)
    expect(screen.getByText(Z.emptyTitle)).toBeTruthy()
  })

  it('offers every person a way to plan a shift', () => {
    const onAdd = vi.fn()
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: /Meier Anna/ }))
    expect(onAdd).toHaveBeenCalledWith(people[0])
  })

  it('shows a planned shift as an editable von–bis pair', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    expect(screen.getByLabelText(`${Z.from} – Meier Anna`)).toBeTruthy()
    expect(screen.getByLabelText(`${Z.to} – Meier Anna`)).toBeTruthy()
  })

  it('gives a viewer the read-out but no controls', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    render(<ZeitplanView {...base} canEdit={false} attendance={{}} shifts={shifts} />)
    expect(screen.queryByRole('button', { name: new RegExp(Z.remove) })).toBeNull()
    expect(screen.queryByRole('button', { name: /Meier Anna/ })).toBeNull() // no «+»
  })

  it('marks a person double-booked without refusing the plan', () => {
    const shifts: Shift[] = [
      { id: 'sh1', personId: 'p1', from: T(14), to: T(19) },
      { id: 'sh2', personId: 'p1', from: T(18), to: T(22) },
    ]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    // both bars carry the conflict note, and both shifts are still there to edit
    expect(screen.getAllByTitle(Z.conflict).length).toBe(2)
    expect(screen.getAllByLabelText(`${Z.from} – Meier Anna`)).toHaveLength(2)
  })

  it('draws the plan and the recorded presence as separate bars on the same row', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    const attendance: AttendanceState = {
      p1: { status: 'left', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(14), to: T(15) }] },
    }
    render(<ZeitplanView {...base} attendance={attendance} shifts={shifts} />)
    expect(screen.getAllByTitle(new RegExp(`^${Z.planned}:`))).toHaveLength(1)
    expect(screen.getAllByTitle(new RegExp(`^${Z.actual}:`))).toHaveLength(1)
  })

  it('never claims to know the future: coverage past now counts nobody present', () => {
    const attendance: AttendanceState = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(12) }] },
    }
    const { container } = render(<ZeitplanView {...base} attendance={attendance} shifts={[]} />)
    const actualBars = Array.from(container.querySelectorAll('[class*="covActual"]')) as HTMLElement[]
    expect(actualBars.length).toBeGreaterThan(0)
    // the last slot lies past `nowMs` → zero height
    expect(actualBars[actualBars.length - 1].style.height).toBe('0%')
  })
})
