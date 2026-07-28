import { describe, expect, it } from 'vitest'
import {
  SLOT_MS, bandAssignWindow, bandCell, bandCellWindow, bandCounts, bandCoverFraction, barGeometry,
  ceilSlot, unshownShifts,
  conflictingShiftIds, coverage, draftBand, draftShift, dragShift, floorSlot, freehandShifts,
  intervalSpan, overlaps, plannedPersonCount, shiftAt, shiftInBand, shiftSpan, shiftsFor, sortBands,
  timeAtFraction, timelineSpan,
} from './shifts'
import type { AttendanceState, Shift, ShiftBand } from '../types'

const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
const ms = (iso: string) => Date.parse(iso)
const shift = (id: string, personId: string, from: string, to: string): Shift => ({ id, personId, from, to })
const MIDNIGHT = '2026-07-27T00:00:00.000Z' // the right edge of a window written as T(24)

describe('slot grid', () => {
  it('snaps to the half hour so a bar never starts on half a column', () => {
    expect(floorSlot(ms(T(14, 17)))).toBe(ms(T(14, 0)))
    expect(ceilSlot(ms(T(14, 17)))).toBe(ms(T(14, 30)))
    expect(ceilSlot(ms(T(14, 30)))).toBe(ms(T(14, 30))) // already on the grid
  })
})

describe('timelineSpan', () => {
  const att: AttendanceState = {}

  it('is exactly as long as the Zeitraum asks for', () => {
    const span = timelineSpan(T(12), [], att, ms(T(13)))
    expect(span.from).toBe(ms(T(12)))
    expect(span.to - span.from).toBe(12 * 3_600_000)
    expect(timelineSpan(T(12), [], att, ms(T(13)), 6).to - ms(T(12))).toBe(6 * 3_600_000)
  })

  it('does NOT stretch to swallow a shift planned into tomorrow', () => {
    // asking for a narrow window and getting a 30 h axis is the opposite of what was asked;
    // a far-off shift is reached by widening the Zeitraum, not by the axis deciding for you
    const far = [shift('s1', 'p1', T(22), '2026-07-28T04:00:00.000Z')]
    const span = timelineSpan(T(12), far, att, ms(T(13)), 6)
    expect(span.to - span.from).toBe(6 * 3_600_000)
  })

  it('does not stretch for a long executed block either', () => {
    const withAtt: AttendanceState = {
      p1: { status: 'left', displayNameSnapshot: 'M', intervals: [{ from: T(12), to: '2026-07-27T06:00:00.000Z' }] },
    }
    expect(timelineSpan(T(12), [], withAtt, ms(T(13)), 12).to - ms(T(12))).toBe(12 * 3_600_000)
  })

  it('stays near NOW on a long incident instead of opening on an empty yesterday', () => {
    const now = ms(T(12)) + 50 * 3_600_000
    const span = timelineSpan(T(12), [], att, now)
    expect(span.from).toBeGreaterThanOrEqual(now - 3 * 3_600_000)
  })

  it('still opens at the incident start while that is the nearer edge', () => {
    expect(timelineSpan(T(12), [], att, ms(T(13))).from).toBe(ms(T(12)))
  })

  it('refuses a nonsense window rather than collapsing the axis', () => {
    expect(timelineSpan(T(12), [], att, ms(T(13)), 0).to - ms(T(12))).toBe(3_600_000)
    expect(timelineSpan(T(12), [], att, ms(T(13)), 999).to - ms(T(12))).toBe(96 * 3_600_000)
  })
})

describe('barGeometry', () => {
  const span = { from: ms(T(12)), to: ms(T(24)) }

  it('places a bar as fractions of the window', () => {
    const g = barGeometry(ms(T(18)), ms(T(21)), span)
    expect(g?.left).toBeCloseTo(0.5)
    expect(g?.width).toBeCloseTo(0.25)
  })

  it('clips a bar that runs past the window rather than overflowing it', () => {
    const g = barGeometry(ms(T(6)), ms(T(15)), span)
    expect(g?.left).toBe(0)
    expect(g?.width).toBeCloseTo(0.25)
  })

  it('drops a bar that lies entirely outside', () => {
    expect(barGeometry(ms(T(2)), ms(T(5)), span)).toBeNull()
  })
})

describe('spans', () => {
  it('refuses a shift whose end is not after its start', () => {
    expect(shiftSpan(shift('s', 'p', T(18), T(14)))).toBeNull()
    expect(shiftSpan(shift('s', 'p', T(14), T(14)))).toBeNull()
    expect(shiftSpan({ id: 's', personId: 'p', from: 'kaputt', to: T(14) })).toBeNull()
  })

  it('runs an OPEN presence block to now, so the solid bar grows while someone is on site', () => {
    expect(intervalSpan({ from: T(14) }, ms(T(16)))).toEqual({ from: ms(T(14)), to: ms(T(16)) })
  })
})

describe('overlap flagging', () => {
  it('does not call back-to-back shifts a conflict', () => {
    expect(overlaps(shift('a', 'p1', T(14), T(18)), shift('b', 'p1', T(18), T(22)))).toBe(false)
  })

  it('flags both sides of a real overlap — two ASSIGNED shifts at the same time', () => {
    const list = [
      { ...shift('a', 'p1', T(14), T(19)), confirmed: true },
      { ...shift('b', 'p1', T(18), T(22)), confirmed: true },
    ]
    expect(conflictingShiftIds(list)).toEqual(new Set(['a', 'b']))
  })

  // The everyday pair the sheet exists to show: a window is offered, part of it is assigned.
  // Testing raw time overlap painted this red, which taught people to ignore the colour.
  it('leaves an assignment sitting inside its own availability alone', () => {
    const list = [
      shift('a', 'p1', T(17, 30), T(21)),
      { ...shift('b', 'p1', T(18, 30), T(20)), confirmed: true },
    ]
    expect(conflictingShiftIds(list).size).toBe(0)
  })

  it('does not flag two overlapping offers either — nothing is committed yet', () => {
    const list = [shift('a', 'p1', T(14), T(19)), shift('b', 'p1', T(18), T(22))]
    expect(conflictingShiftIds(list).size).toBe(0)
  })

  it('never confuses two different people', () => {
    const list = [
      { ...shift('a', 'p1', T(14), T(19)), confirmed: true },
      { ...shift('b', 'p2', T(14), T(19)), confirmed: true },
    ]
    expect(conflictingShiftIds(list).size).toBe(0)
  })
})

describe('coverage — the hole at 02:00 a wall of bars hides', () => {
  const span = { from: ms(T(12)), to: ms(T(16)) }
  const at = (slots: ReturnType<typeof coverage>, iso: string) => slots.find((c) => c.at === ms(iso))!

  it('counts the three states apart, per slot', () => {
    const list = [
      { ...shift('a', 'p1', T(12), T(14)), confirmed: true },
      shift('b', 'p2', T(12), T(16)),              // offered, not assigned
    ]
    const slots = coverage(list, {}, span, ms(T(16)))
    expect(at(slots, T(13)).planned).toBe(1)     // only the confirmed one
    expect(at(slots, T(13)).available).toBe(1)
    expect(at(slots, T(15)).planned).toBe(0)     // p1's shift ended — the gap is visible
    expect(at(slots, T(15)).available).toBe(1)
  })

  it('counts who is actually there, from the presence blocks', () => {
    const att: AttendanceState = {
      p1: { status: 'left', displayNameSnapshot: 'M', intervals: [{ from: T(12), to: T(13) }] },
      p2: { status: 'present', displayNameSnapshot: 'H', intervals: [{ from: T(12) }] },
    }
    const slots = coverage([], att, span, ms(T(16)))
    expect(at(slots, T(12, 30)).actual).toBe(2)
    expect(at(slots, T(13, 30)).actual).toBe(1) // p1 gone, p2's open block runs on
  })

  it('claims nothing about the future — actual stays 0 past now', () => {
    const att: AttendanceState = { p1: { status: 'present', displayNameSnapshot: 'M', intervals: [{ from: T(12) }] } }
    const slots = coverage([], att, span, ms(T(14)))
    expect(at(slots, T(13)).actual).toBe(1)
    expect(at(slots, T(15)).actual).toBe(0)
  })

  it('covers the window in half-hour slots', () => {
    expect(coverage([], {}, span, ms(T(16)))).toHaveLength((span.to - span.from) / SLOT_MS)
  })
})

describe('row helpers', () => {
  it('gives a person their own shifts, earliest first', () => {
    const list = [shift('b', 'p1', T(20), T(23)), shift('a', 'p1', T(14), T(18)), shift('c', 'p2', T(14), T(18))]
    expect(shiftsFor(list, 'p1').map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('counts people, not shifts', () => {
    expect(plannedPersonCount([shift('a', 'p1', T(14), T(18)), shift('b', 'p1', T(20), T(23))])).toBe(1)
  })
})

describe('draftShift', () => {
  it('opens on the next slot boundary for one default watch', () => {
    const d = draftShift('p1', ms(T(14, 17)), T(12), 8)
    expect(d.from).toBe(T(14, 30))
    expect(d.to).toBe('2026-07-26T22:30:00.000Z')
    expect(d.id.startsWith('sh')).toBe(true)
  })

  it('anchors to the incident start while that is still ahead (planning before the alarm time)', () => {
    expect(draftShift('p1', ms(T(10)), T(12), 4).from).toBe(T(12))
  })
})


describe('direct manipulation on the grid', () => {
  const span = { from: ms(T(12)), to: ms(T(24)) }

  it('snaps a tap to the half-hour grid', () => {
    expect(timeAtFraction(0.5, span)).toBe(ms(T(18)))
    expect(timeAtFraction(0.51, span)).toBe(ms(T(18)))   // 18:07 → 18:00
    expect(timeAtFraction(0.54, span)).toBe(ms(T(18, 30)))
  })

  it('never yields an invalid time from an unmeasurable lane or a coordinate-less press', () => {
    // a zero-width lane mid-layout used to produce NaN and crash the surface on the next render
    expect(timeAtFraction(NaN, span)).toBe(span.from)
    expect(timeAtFraction(Infinity, span)).toBe(span.to)
    const sh = shiftAt('p1', NaN, 8, span)
    expect(Number.isFinite(Date.parse(sh.from))).toBe(true)
    expect(Number.isFinite(Date.parse(sh.to))).toBe(true)
  })

  it('plans one default watch where the finger landed, clipped to the window', () => {
    const sh = shiftAt('p1', ms(T(14)), 8, span)
    expect(sh.from).toBe(T(14))
    expect(sh.to).toBe(T(22))
    // a tap near the right edge yields a short shift rather than one running off the axis
    expect(shiftAt('p1', ms(T(23, 30)), 8, span).to).toBe(MIDNIGHT)
  })

  it('moves a bar whole, keeping its length', () => {
    const sh = shift('a', 'p1', T(14), T(18))
    const moved = dragShift(sh, 'move', 2 * 3_600_000, span)
    expect(moved.from).toBe(T(16))
    expect(moved.to).toBe(T(20))
  })

  it('keeps a moved bar its own length, wherever it lands', () => {
    const sh = shift('a', 'p1', T(14), T(18))
    const out = dragShift(sh, 'move', -99 * 3_600_000, span)
    expect(Date.parse(out.to) - Date.parse(out.from)).toBe(4 * 3_600_000)
  })

  // the window is a viewport, not a constraint on the data: clamping to it used to snap any shift
  // LONGER than the visible window to the window start — 10:00–22:00 became 14:00–02:00 on a 6 h
  // horizon, four hours adrift, from a one-minute slip, with no undo
  it('never relocates a shift that is longer than the visible window', () => {
    const narrow = { from: ms(T(14)), to: ms(T(20)) } // 6 h
    const long = shift('a', 'p1', T(10), T(22))       // 12 h
    const out = dragShift(long, 'move', 60_000, narrow)
    expect(out.from).toBe(T(10))
    expect(out.to).toBe(T(22))
  })

  it('stretches one end without ever inverting the bar', () => {
    const sh = shift('a', 'p1', T(14), T(18))
    expect(dragShift(sh, 'from', 2 * 3_600_000, span).from).toBe(T(16))
    expect(dragShift(sh, 'to', -2 * 3_600_000, span).to).toBe(T(16))
    // dragged past its other end it stops one slot short, not backwards
    expect(dragShift(sh, 'from', 99 * 3_600_000, span).from).toBe(T(17, 30))
    expect(dragShift(sh, 'to', -99 * 3_600_000, span).to).toBe(T(14, 30))
  })

  it('leaves a shift alone when the drag distance is not a number', () => {
    const sh = shift('a', 'p1', T(14), T(18))
    expect(dragShift(sh, 'move', NaN, span)).toBe(sh)
  })
})

// ---------------------------------------------------------------- Schichtbänder (the columns)

const band = (id: string, from: string, to: string, label = ''): ShiftBand => ({ id, label, from, to })
const inBand = (id: string, personId: string, from: string, to: string, bandId: string, confirmed?: boolean): Shift =>
  ({ id, personId, from, to, bandId, ...(confirmed ? { confirmed } : {}) })

describe('bandCell — a column reads the shift that covers it, state and all', () => {
  const früh = band('bd1', T(7), T(12), 'Früh')

  it('shows somebody as available when their own offer covers the whole window', () => {
    // THE point: they drew 06–13 on the axis, so they ARE free for 07–12. Asking them to tap a
    // cell to say so a second time is the surface asking a question it already has the answer to.
    const own = shift('a', 'p1', T(6), T(13))
    expect(bandCell([own], 'p1', früh)).toEqual({ state: 'available', shift: own, derived: true })
  })

  it('shows the REAL hours when the offer covers only part of the window', () => {
    // «frei» here would promise five hours somebody never offered
    const own = shift('a', 'p1', T(10), T(20))
    expect(bandCell([own], 'p1', früh)).toMatchObject({ state: 'deviating', derived: true })
  })

  it('shows somebody geplant across the window as GEPLANT, filed under the band or not', () => {
    // reported 28.07.: geplant 10:00–20:00 read «verfügbar» in both watches it covers. `confirmed`
    // is the shift's own state — refusing to read it is not caution, it is the column disagreeing
    // with the plan.
    const own: Shift = { id: 'a', personId: 'p1', from: T(6), to: T(13), confirmed: true }
    expect(bandCell([own], 'p1', früh).state).toBe('confirmed')
  })

  it('prefers the assignment over an availability that covers just as much', () => {
    // «verfügbar 09–11» and «geplant 10–20» each cover two of Früh's five hours; the one that says
    // where the person is actually going is the one the column has to show
    const frei = shift('frei', 'p1', T(9), T(11))
    const plan: Shift = { id: 'plan', personId: 'p1', from: T(10), to: T(20), confirmed: true }
    expect(bandCell([frei, plan], 'p1', früh).shift?.id).toBe('plan')
  })

  it('lets a STORED member win the cell over any other offer that also overlaps', () => {
    const member = inBand('m', 'p1', T(7), T(12), 'bd1', true)
    const own = shift('a', 'p1', T(6), T(13))
    expect(bandCell([own, member], 'p1', früh)).toEqual({ state: 'confirmed', shift: member, derived: false })
  })

  it('keeps a member in its band after its times were dragged away, hatched', () => {
    // nobody falls out of a column because somebody nudged the band by five minutes
    const drifted = inBand('a', 'p1', T(9), T(14), 'bd1', true)
    expect(bandCell([drifted], 'p1', früh)).toEqual({ state: 'deviating', shift: drifted, derived: false })
  })

  it('picks the offer that covers MOST of the window when several overlap', () => {
    const little = shift('a', 'p1', T(11), T(12))
    const lots = shift('b', 'p1', T(8), T(12))
    expect(bandCell([little, lots], 'p1', früh).shift?.id).toBe('b')
  })

  it('is empty for somebody who has offered nothing that reaches the window', () => {
    expect(bandCell([shift('a', 'p1', T(14), T(18))], 'p1', früh)).toEqual({ state: 'empty', derived: false })
    expect(bandCell([], 'p1', früh).state).toBe('empty')
  })

  it('reads the plain two states off a member sitting exactly on the band', () => {
    expect(bandCell([inBand('a', 'p1', T(7), T(12), 'bd1')], 'p1', früh).state).toBe('available')
    expect(bandCell([inBand('a', 'p1', T(7), T(12), 'bd1', true)], 'p1', früh).state).toBe('confirmed')
  })

  it('lists only the shifts belonging to no band as a person\'s own times', () => {
    const list = [inBand('a', 'p1', T(7), T(12), 'bd1'), shift('b', 'p1', T(9), T(14)), shift('c', 'p2', T(9), T(14))]
    expect(freehandShifts(list, 'p1').map((x) => x.id)).toEqual(['b'])
  })

  it('finds the stored member by bandId and never by matching clocks', () => {
    expect(shiftInBand([shift('a', 'p1', T(7), T(12))], 'p1', 'bd1')).toBeUndefined()
  })
})

describe('bandCellWindow — a cell shows only its own column', () => {
  const früh = band('bd1', T(7), T(12), 'Früh')

  it('clamps a longer offer to the band', () => {
    // reported 28.07.: verfügbar 05–08 in a watch ending at 06:00 must read 05–06 — the rest of
    // that stretch is a fact about the Zeitplan axis, not about this column
    const cell = bandCell([shift('a', 'p1', T(5), T(8))], 'p1', band('bd9', T(4), T(6)))
    expect(bandCellWindow(cell, band('bd9', T(4), T(6)))).toEqual({ from: T(5), to: T(6) })
  })

  it('clamps a member whose times drifted past the band end', () => {
    const cell = bandCell([inBand('a', 'p1', T(9), T(14), 'bd1', true)], 'p1', früh)
    expect(bandCellWindow(cell, früh)).toEqual({ from: T(9), to: T(12) })
  })

  it('has no cell at all once a member has been dragged clear of its band', () => {
    // reported 28.07.: «20:30–21» printed inside a 12–17 watch, counted as one assigned person who
    // covers none of it. Membership means «in this window»; once the window has moved on, the
    // column is silent and the row's «eigene Zeiten» mark carries those hours instead.
    const cell = bandCell([inBand('a', 'p1', T(14), T(18), 'bd1', true)], 'p1', früh)
    expect(cell).toEqual({ state: 'empty', derived: false })
    expect(bandCellWindow(cell, früh)).toBeNull()
    expect(bandCounts([inBand('a', 'p1', T(14), T(18), 'bd1', true)], früh)).toEqual({ available: 0, confirmed: 0 })
  })

  it('lists a drifted-out member under the times no column is showing', () => {
    const drifted = inBand('a', 'p1', T(14), T(18), 'bd1', true)
    expect(unshownShifts([drifted], 'p1', [früh]).map((x) => x.id)).toEqual(['a'])
    // …and stays quiet the moment a column does pick those hours up
    const spät = band('bd2', T(13), T(19), 'Spät')
    expect(unshownShifts([drifted], 'p1', [früh, spät])).toEqual([])
  })
})

describe('bandAssignWindow — a tap assigns only what was offered', () => {
  const früh = band('bd1', T(7), T(12), 'Früh')

  it('assigns the whole window for an empty cell', () => {
    expect(bandAssignWindow({ state: 'empty', derived: false }, früh)).toEqual({ from: T(7), to: T(12) })
  })

  it('assigns the OVERLAP for somebody whose offer only reaches into the window', () => {
    // confirming a 10–20 offer into a 07–12 watch must assign 10–12, not five hours they never
    // said they could do
    const cell = bandCell([shift('a', 'p1', T(10), T(20))], 'p1', früh)
    expect(bandAssignWindow(cell, früh)).toEqual({ from: T(10), to: T(12) })
  })

  it('assigns the BAND when the offer covers all of it, never the offer', () => {
    // reported 28.07.: Schicht 12–17, Verfügbarkeit 10–18 — tapping must plan 12–17 and must not
    // stretch the watch out to somebody's whole day
    const spät = band('bd2', T(12), T(17), 'Spät')
    const cell = bandCell([shift('a', 'p1', T(10), T(18))], 'p1', spät)
    expect(bandAssignWindow(cell, spät)).toEqual({ from: T(12), to: T(17) })
  })
})

describe('bandCounts — whole people, one cell one count', () => {
  const früh = band('bd1', T(7), T(12), 'Früh') // five hours

  it('counts a member on the band as a whole one, in its own state', () => {
    const list = [inBand('a', 'p1', T(7), T(12), 'bd1'), inBand('b', 'p2', T(7), T(12), 'bd1', true)]
    expect(bandCounts(list, früh)).toEqual({ available: 1, confirmed: 1 })
  })

  it('counts a derived availability too — the head must agree with the cells below it', () => {
    expect(bandCounts([shift('a', 'p1', T(6), T(13))], früh)).toEqual({ available: 1, confirmed: 0 })
  })

  it('counts a partly covering person as ONE person, not as a fraction of one', () => {
    // «0,8» is not a headcount. The head is now exactly what you get by counting the cells below
    // it — the nuance lives in the cell, which prints the hours it actually covers.
    expect(bandCoverFraction(inBand('a', 'p1', T(9), T(14), 'bd1', true), früh)).toBeCloseTo(0.6)
    expect(bandCounts([inBand('a', 'p1', T(9), T(14), 'bd1', true)], früh)).toEqual({ available: 0, confirmed: 1 })
  })

  it('counts one person ONCE, even holding both a member shift and a wider offer', () => {
    // one cell is one count — otherwise the head says two where the grid shows one
    const list = [shift('a', 'p1', T(6), T(13)), inBand('m', 'p1', T(7), T(12), 'bd1', true)]
    expect(bandCounts(list, früh)).toEqual({ available: 0, confirmed: 1 })
  })

  it('never counts more than one for a shift that swallows the whole band', () => {
    expect(bandCoverFraction(inBand('a', 'p1', T(0), T(23), 'bd1'), früh)).toBe(1)
  })

  it('counts nothing for a shift clear of the band, and does not go negative', () => {
    expect(bandCoverFraction(inBand('a', 'p1', T(14), T(18), 'bd1'), früh)).toBe(0)
    expect(bandCounts([shift('a', 'p1', T(14), T(18))], früh)).toEqual({ available: 0, confirmed: 0 })
  })

  it('counts a shift filed under ANOTHER band by the state that shift carries', () => {
    // confirmed there means the person is on those hours, and these are the same hours
    expect(bandCounts([inBand('a', 'p1', T(7), T(12), 'bd2', true)], früh)).toEqual({ available: 0, confirmed: 1 })
    expect(bandCounts([inBand('a', 'p1', T(7), T(12), 'bd2')], früh)).toEqual({ available: 1, confirmed: 0 })
  })
})

describe('draftBand — what the sheet opens on', () => {
  it('starts the second band where the last one ended, running just as long', () => {
    // «wir fahren 07–12 und 12–17» is one sentence; typing 12:00 twice is the re-entry the whole
    // grid exists to remove
    const d = draftBand([band('bd1', T(7), T(12))], ms(T(9)), null, 4)
    expect(d.from).toBe(T(12))
    expect(d.to).toBe(T(17))
  })

  it('anchors the first band on the next half hour when the incident is already running', () => {
    const d = draftBand([], ms(T(9, 10)), T(7), 5)
    expect(d.from).toBe(T(9, 30))
    expect(d.to).toBe(T(14, 30))
  })

  it('anchors the first band on the incident start while that is still ahead', () => {
    const d = draftBand([], ms(T(6)), T(7), 5)
    expect(d.from).toBe(T(7))
  })
})

describe('sortBands', () => {
  it('orders by start, then end, then id — stable, so a column never swaps under a finger', () => {
    const list = [band('b', T(12), T(17)), band('c', T(7), T(14)), band('a', T(7), T(12))]
    expect(sortBands(list).map((x) => x.id)).toEqual(['a', 'c', 'b'])
    expect(list.map((x) => x.id)).toEqual(['b', 'c', 'a']) // input untouched
  })
})

describe('conflicts inside bands', () => {
  it('flags one person assigned in two overlapping bands, and leaves offers alone', () => {
    // «Überlappende Bänder erlaubt»: leer/verfügbar may overlap freely — only two CONFIRMED
    // shifts of the same person are a genuine double booking, and even then it is reported,
    // never refused
    const offers = [inBand('a', 'p1', T(7), T(12), 'bd1'), inBand('b', 'p1', T(10), T(15), 'bd2')]
    expect(conflictingShiftIds(offers).size).toBe(0)
    const booked = [inBand('a', 'p1', T(7), T(12), 'bd1', true), inBand('b', 'p1', T(10), T(15), 'bd2', true)]
    expect([...conflictingShiftIds(booked)].sort()).toEqual(['a', 'b'])
  })
})
