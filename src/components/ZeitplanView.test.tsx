// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ZeitplanView } from './ZeitplanView'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
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
/** the same, but from a FINGER — the lane treats the two differently, because on touch the browser
 *  and the section pager are both competing for a horizontal drag and a mouse has no such rivals */
const touch = (el: Element, type: string, clientX: number) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
  Object.defineProperty(ev, 'pointerType', { value: 'touch' })
  fireEvent(el, ev)
}
/** hold still for longer than the lane's arming delay */
const hold = () => act(() => { vi.advanceTimersByTime(500) })
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

  // A finger plans the same way a mouse does — no hold, no second idiom to learn. That only
  // works because the two things that used to eat the gesture are gone: the section pager (off
  // for this whole surface while the Zeitplan shows) and the browser's sideways panning (the lane
  // takes it with `touch-action: pan-y`). Neither is visible from here, so these pin the outcome.
  describe('on touch, the sweep behaves exactly as it does with a mouse', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('plans the stretch a finger swept out', () => {
      const onAddSpan = vi.fn()
      render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
      const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
      sizeLane(lane, 1200)
      touch(lane, 'pointerdown', 200)
      touch(lane, 'pointermove', 500)
      touch(lane, 'pointerup', 500)
      expect(onAddSpan).toHaveBeenCalledTimes(1)
      const [, from, to] = onAddSpan.mock.calls[0]
      expect(to - from).toBe(3 * 3_600_000)
    })

    it('opens the sheet on a press-and-hold, and plans nothing', () => {
      const onAddSpan = vi.fn()
      render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
      const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
      sizeLane(lane, 1200)
      touch(lane, 'pointerdown', 500)
      hold()
      touch(lane, 'pointerup', 500)
      expect(onAddSpan).not.toHaveBeenCalled()
      expect(screen.getByText(fillTemplate(Z.editTitle, { name: 'Meier Anna' }))).toBeTruthy()
    })

    // A stylus is MORE precise than a finger, so a deliberate slow start stays inside DRAG_PX
    // for the whole 450ms and used to open the sheet on top of the sweep somebody was aiming at.
    // Pen and mouse keep the name cell as their visible way in, so they lose nothing.
    it('does not open the sheet on a hold from a pen or a mouse', () => {
      const onAddSpan = vi.fn()
      render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
      const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
      sizeLane(lane, 1200)
      ptr(lane, 'pointerdown', 200)
      hold()
      ptr(lane, 'pointermove', 500)
      ptr(lane, 'pointerup', 500)
      expect(screen.queryByText(fillTemplate(Z.editTitle, { name: 'Meier Anna' }))).toBeNull()
      expect(onAddSpan).toHaveBeenCalledTimes(1)
    })

    it('a sweep that started before the hold landed still draws, and never opens the sheet', () => {
      const onAddSpan = vi.fn()
      render(<ZeitplanView {...base} attendance={{}} shifts={[]} onAddSpan={onAddSpan} />)
      const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
      sizeLane(lane, 1200)
      touch(lane, 'pointerdown', 200)
      touch(lane, 'pointermove', 300) // the finger moved first, so the hold must be dead
      hold()
      touch(lane, 'pointermove', 500)
      touch(lane, 'pointerup', 500)
      expect(screen.queryByText(fillTemplate(Z.editTitle, { name: 'Meier Anna' }))).toBeNull()
      expect(onAddSpan).toHaveBeenCalledTimes(1)
    })
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
    const bar = screen.getByTitle(new RegExp(`^${Z.available}:`))
    ptr(bar, 'pointerdown', 300)
    ptr(bar, 'pointerup', 300)
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ id: 'sh1', confirmed: true }))
    expect(onRemove).not.toHaveBeenCalled() // deleting lives in the sheet only
  })

  // a lane is 44px tall and a bar only ~34px, so a tap a few pixels high used to hit dead ground
  it('flips the bar even when the tap lands above or below it, at that time', () => {
    const onReplace = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(18) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} onReplace={onReplace} />)
    const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
    // the window opens at 14:00 (2 h look-back from NOW=16:00) and runs 12 h over 1200px,
    // so 100px per hour: x=200 is 16:00, inside the 14–18 bar
    sizeLane(lane, 1200)
    ptr(lane, 'pointerdown', 200)
    ptr(lane, 'pointerup', 200)
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ id: 'sh1', confirmed: true }))
  })

  it('still does nothing when the tap is at a time no bar covers', () => {
    const onReplace = vi.fn(); const onAddSpan = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(15) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} onReplace={onReplace} onAddSpan={onAddSpan} />)
    const lane = screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' }))
    sizeLane(lane, 1200)
    ptr(lane, 'pointerdown', 900) // 23:00 — well clear of the 14–15 bar
    ptr(lane, 'pointerup', 900)
    expect(onReplace).not.toHaveBeenCalled()
    expect(onAddSpan).not.toHaveBeenCalled()
  })

  it('a drag moves the bar and commits once, on release', () => {
    const onReplace = vi.fn()
    const onRemove = vi.fn()
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(18) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} onReplace={onReplace} onRemove={onRemove} />)
    sizeLane(screen.getByLabelText(fillTemplate(Z.planAt, { name: 'Meier Anna' })))
    const bar = screen.getByTitle(new RegExp(`^${Z.available}:`))
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
      { id: 'sh1', personId: 'p1', from: T(14), to: T(19), confirmed: true },
      { id: 'sh2', personId: 'p1', from: T(18), to: T(22), confirmed: true },
    ]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    // both bars flagged, neither refused — plus the sign in the sticky name cell, so the person
    // is identifiable while the clash itself is scrolled off the axis
    expect(screen.getAllByTitle(Z.conflict).length).toBe(3)
  })

  // A reversed shift has no span, so barGeometry drew nothing at all: invisible on the grid, zero
  // minutes on the Rapport, findable only by opening the person's sheet on a hunch.
  it('marks a shift whose end is before its start instead of drawing nothing', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(19), to: T(14) }]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    const mark = screen.getByTitle(Z.brokenShift)
    expect(mark).toBeTruthy()
    fireEvent.click(mark)
    expect(screen.getByText(fillTemplate(Z.editTitle, { name: 'Meier Anna' }))).toBeTruthy()
  })

  // The normal shape of the form: a window is offered, part of it is assigned. Flagging that as a
  // conflict — which raw time-overlap did — put red on the everyday case and taught people to
  // ignore it, leaving the genuine double booking above indistinguishable.
  it('does not call an assignment inside its own availability a conflict', () => {
    const shifts: Shift[] = [
      { id: 'sh1', personId: 'p1', from: T(14), to: T(20) },
      { id: 'sh2', personId: 'p1', from: T(15), to: T(18), confirmed: true },
    ]
    render(<ZeitplanView {...base} attendance={{}} shifts={shifts} />)
    expect(screen.queryAllByTitle(Z.conflict).length).toBe(0)
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
    expect(screen.getAllByTitle(new RegExp(`^${Z.available}:`))).toHaveLength(1)
    expect(screen.getAllByTitle(new RegExp(`^${Z.actual}:`))).toHaveLength(1)
  })

  // the curve says WHERE the hole is and never how many — the row folds out to the numbers, and
  // it stays folded until asked, because three rows of digits cost a phone two people of Mannschaft
  it('keeps the Deckung numbers folded away until the row is pressed', () => {
    const shifts: Shift[] = [{ id: 'sh1', personId: 'p1', from: T(14), to: T(18), confirmed: true }]
    const attendance: AttendanceState = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(14) }] },
    }
    render(<ZeitplanView {...base} attendance={attendance} shifts={shifts} />)
    const row = screen.getByTitle(Z.coverageExpand)
    expect(row.tagName).toBe('BUTTON') // keyboard-reachable, not a div with a click handler
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).toBe(Z.coverage)
    // the colour key moved into this row from its own legend line under the grid, and it STAYS —
    // only the counts fold away
    for (const label of [Z.available, Z.confirmed, Z.actual]) expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryAllByTitle(Z.now)).toHaveLength(0)

    fireEvent.click(row)
    const open = screen.getByTitle(Z.coverageCollapse)
    expect(open.getAttribute('aria-expanded')).toBe('true')
    // each state carries its own count at «jetzt»: nobody merely available, one assigned — and
    // anwesend is 0 because the slot «jetzt» falls into runs past now, and this surface never
    // claims to know the future
    expect(screen.getAllByTitle(Z.now).map((n) => n.textContent)).toEqual(['0', '1', '0'])

    fireEvent.click(open)
    expect(screen.getByTitle(Z.coverageExpand).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByTitle(Z.now)).toHaveLength(0)
  })

  it('never claims to know the future: the anwesend line drops to the baseline past now', () => {
    const attendance: AttendanceState = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: T(12) }] },
    }
    const { container } = render(<ZeitplanView {...base} attendance={attendance} shifts={[]} />)
    const svg = container.querySelector('[class*="covSvg"]') as SVGSVGElement
    const line = container.querySelector('[class*="lineActual"]') as SVGPolylineElement
    // viewBox is "0 0 <slots> <peak>" and y is flipped, so y === peak means a count of zero
    const peak = Number(svg.getAttribute('viewBox')!.split(' ')[3])
    const ys = line.getAttribute('points')!.split(' ').map((pt) => Number(pt.split(',')[1]))
    expect(ys.some((y) => y < peak)).toBe(true)          // somebody IS present, before now
    expect(ys[ys.length - 1]).toBe(peak)                 // …and nobody is claimed after it
  })

  it('drops the hour label the JETZT flag would sit on, and keeps the rest of the clock', () => {
    const { container } = render(<ZeitplanView {...base} attendance={{}} shifts={[]} />)
    const ticks = [...container.querySelectorAll('[class*="tick"]')].map((t) => t.textContent)
    // The flag is opaque, so a label underneath it does not vanish — its ends stick out and read
    // as a broken glyph beside «JETZT». The label at now goes; its neighbours two hours out stay,
    // because an axis that quietly drops its clock is the other failure this surface can have.
    expect(ticks).not.toContain(hhmm(new Date(NOW)))
    expect(ticks).toContain(hhmm(new Date(NOW + 2 * 3_600_000)))
    expect(ticks).toContain(hhmm(new Date(NOW - 2 * 3_600_000)))
  })
})
