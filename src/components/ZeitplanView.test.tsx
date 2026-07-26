// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ZeitplanView } from './ZeitplanView'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
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


// jsdom implements no PointerEvent, and fireEvent.pointerDown silently drops clientX with it —
// a gesture test that cannot say WHERE the finger landed tests nothing. MouseEvent carries the
// coordinates and React routes purely on the event type.
const ptr = (el: Element, type: string, clientX: number) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }))
/** jsdom lays nothing out, so the lane must be told how wide it is for a fraction to mean anything */
const sizeLane = (el: Element, width = 1200) => {
  el.getBoundingClientRect = () => ({ left: 0, width, right: width, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

const Z = appConfig.copy.zeitplan
const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
const NOW = Date.parse(T(16))

const people: Person[] = [
  { id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: T(12) },
  { id: 'p2', displayName: 'Huber Beat', active: true, updatedAt: T(12) },
]
const base = {
  people, canEdit: true, startedAt: T(12), nowMs: NOW,
  onAdd: () => {}, onAddSpan: () => {}, onReplace: () => {}, onSetTime: () => {}, onRemove: () => {},
  horizonH: 12, onHorizon: () => {},
}

describe('ZeitplanView', () => {
  it('teaches what the surface is for while nothing is planned', () => {
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} />)
    expect(screen.getByText(Z.emptyTitle)).toBeTruthy()
  })

  it('plans exactly the stretch swept out, with no «+» in the row', () => {
    const onAddSpan = vi.fn()
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
    expect(screen.queryByRole('button', { name: /Schicht für .* planen/ })).toBeNull()
    const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
    sizeLane(lane, 1200) // a 12 h window over 1200px → 100px per hour
    ptr(lane, 'pointerdown', 200)
    ptr(lane, 'pointermove', 500)
    ptr(lane, 'pointerup', 500)
    expect(onAddSpan).toHaveBeenCalledTimes(1)
    const [p, from, to] = onAddSpan.mock.calls[0]
    expect(p.id).toBe('p1')
    expect(to - from).toBe(3 * 3_600_000) // the three hours actually drawn
  })

  it('does nothing when empty lane is merely tapped — planning is a sweep', () => {
    const onAddSpan = vi.fn()
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
    const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
    sizeLane(lane)
    ptr(lane, 'pointerdown', 500)
    ptr(lane, 'pointerup', 500)
    expect(onAddSpan).not.toHaveBeenCalled()
  })

  it('flips a shift between «geplant» and «fix» when its bar is tapped — never deletes it', () => {
    const onReplace = vi.fn(); const onRemove = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(18) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} onReplace={onReplace} onRemove={onRemove} />)
    sizeLane(screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' })))
    const bar = screen.getByTitle(new RegExp(`^${Z.tentative}:`))
    ptr(bar, 'pointerdown', 300)
    ptr(bar, 'pointerup', 300)
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ id: 'sh1', confirmed: true }))
    expect(onRemove).not.toHaveBeenCalled() // deleting lives in the sheet only
  })

  it('a drag moves the bar and commits once, on release', () => {
    const onReplace = vi.fn()
    const onRemove = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(18) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} onReplace={onReplace} onRemove={onRemove} />)
    sizeLane(screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' })))
    const bar = screen.getByTitle(new RegExp(`^${Z.tentative}:`))
    ptr(bar, 'pointerdown', 100)
    ptr(bar, 'pointermove', 200)
    ptr(bar, 'pointerup', 200)
    expect(onReplace).toHaveBeenCalledTimes(1)
    expect(onRemove).not.toHaveBeenCalled() // a drag is not a tap
    expect(Date.parse(onReplace.mock.calls[0][0].from)).toBeGreaterThan(Date.parse(T(14)))
  })

  it('keeps the row itself clean — the times live on the person sheet', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    expect(screen.queryByLabelText(`${Z.from} – Meier Anna`)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(Z.openFor, { name: 'Meier Anna' }) }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByLabelText(`${Z.from} – Meier Anna`)).toBeTruthy()
    expect(within(sheet).getByLabelText(`${Z.to} – Meier Anna`)).toBeTruthy()
  })

  it('gives a viewer the read-out but no way to change the plan', () => {
    const onAddSpan = vi.fn(); const onRemove = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    render(<ZeitplanView {...base} canEdit={false} attendance={{}} shifts={shifts} onAddSpan={onAddSpan} onRemove={onRemove} />)
    const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
    sizeLane(lane)
    ptr(lane, 'pointerdown', 200)
    ptr(lane, 'pointermove', 500)
    ptr(lane, 'pointerup', 500)
    expect(onAddSpan).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.queryByTitle(Z.dragFrom)).toBeNull() // no resize handles either
  })

  it('marks a person double-booked without refusing the plan', () => {
    const shifts: Shift[] = [
      { id: 'sh1', personId: 'p1', from: T(14), to: T(19) },
      { id: 'sh2', personId: 'p1', from: T(18), to: T(22) },
    ]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    expect(screen.getAllByTitle(Z.conflict).length).toBe(2) // both bars flagged, neither refused
  })

  // Two von–bis pairs beside a name turn the row into a puzzle, so from the second shift on the
  // chips collapse into one button onto that person's sheet.
  it('collapses several shifts behind the row, which opens the person sheet', () => {
    const shifts: Shift[] = [
      { id: 'sh1', personId: 'p1', from: T(14), to: T(18) },
      { id: 'sh2', personId: 'p1', from: T(20), to: T(23) },
    ]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    expect(screen.queryByLabelText(`${Z.from} – Meier Anna`)).toBeNull() // no inline chips
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(Z.openFor, { name: 'Meier Anna' }) }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getAllByLabelText(`${Z.from} – Meier Anna`)).toHaveLength(2)
  })

  // the sheet carries BOTH halves of a person's time: the availability we plan, and the presence
  // that actually happened — which is the record and is only ticked in the Anwesenheit list
  it('shows planned availability and recorded presence side by side in the sheet', () => {
    const shifts: Shift[] = [
      { id: 'sh1', personId: 'p1', from: T(14), to: T(18) },
      { id: 'sh2', personId: 'p1', from: T(20), to: T(23) },
    ]
    const attendance: AttendanceState = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(14), to: T(15) }, { from: T(20) }] },
    }
    render(<ZeitplanView {...base} attendance={attendance} shifts={shifts} />)
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(Z.openFor, { name: 'Meier Anna' }) }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText(Z.plannedSection)).toBeTruthy()
    expect(within(sheet).getByText(Z.actualSection)).toBeTruthy()
    expect(within(sheet).getByText(Z.stillHere)).toBeTruthy() // the open block is marked as running
    expect(within(sheet).getByText(Z.actualHint)).toBeTruthy() // …and says where it is edited
  })

  it('names every lane, so a bar always belongs to somebody', () => {
    render(<ZeitplanView {...base} attendance={{}} shifts={[]} />)
    for (const p of people) expect(screen.getByText(p.displayName)).toBeTruthy()
  })

  it('draws the plan and the recorded presence as separate bars on the same row', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(22) }]
    const attendance: AttendanceState = {
      p1: { status: 'left', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(14), to: T(15) }] },
    }
    render(<ZeitplanView {...base} attendance={attendance} shifts={shifts} />)
    expect(screen.getAllByTitle(new RegExp(`^${Z.tentative}:`))).toHaveLength(1)
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
