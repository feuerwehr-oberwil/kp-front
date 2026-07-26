import { describe, expect, it } from 'vitest'
import {
  SLOT_MS, barGeometry, ceilSlot, conflictingShiftIds, coverage, draftShift, floorSlot,
  intervalSpan, overlaps, plannedPersonCount, shiftSpan, shiftsFor, timelineSpan,
} from './shifts'
import type { AttendanceState, Shift } from '../types'

const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`
const ms = (iso: string) => Date.parse(iso)
const shift = (id: string, personId: string, from: string, to: string): Shift => ({ id, personId, from, to })

describe('slot grid', () => {
  it('snaps to the half hour so a bar never starts on half a column', () => {
    expect(floorSlot(ms(T(14, 17)))).toBe(ms(T(14, 0)))
    expect(ceilSlot(ms(T(14, 17)))).toBe(ms(T(14, 30)))
    expect(ceilSlot(ms(T(14, 30)))).toBe(ms(T(14, 30))) // already on the grid
  })
})

describe('timelineSpan', () => {
  const att: AttendanceState = {}

  it('opens a 12 h window from the incident start', () => {
    const span = timelineSpan(T(12), [], att, ms(T(13)))
    expect(span.from).toBe(ms(T(12)))
    expect(span.to).toBe(ms(T(24)))
  })

  it('grows so a shift planned into the small hours is reachable, not invisible', () => {
    const span = timelineSpan(T(12), [shift('s1', 'p1', T(22), '2026-07-27T04:00:00.000Z')], att, ms(T(13)))
    expect(span.to).toBe(Date.parse('2026-07-27T04:00:00.000Z'))
  })

  it('grows for a long executed block too', () => {
    const withAtt: AttendanceState = {
      p1: { status: 'left', displayNameSnapshot: 'M', intervals: [{ from: T(12), to: '2026-07-27T06:00:00.000Z' }] },
    }
    expect(timelineSpan(T(12), [], withAtt, ms(T(13))).to).toBe(Date.parse('2026-07-27T06:00:00.000Z'))
  })

  it('always keeps room to plan ahead of the clock', () => {
    const span = timelineSpan(T(12), [], att, ms(T(23, 30)))
    expect(span.to).toBeGreaterThanOrEqual(ms(T(24)) + 30 * 60_000)
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

  it('flags both sides of a real overlap', () => {
    const list = [shift('a', 'p1', T(14), T(19)), shift('b', 'p1', T(18), T(22))]
    expect(conflictingShiftIds(list)).toEqual(new Set(['a', 'b']))
  })

  it('never confuses two different people', () => {
    const list = [shift('a', 'p1', T(14), T(19)), shift('b', 'p2', T(14), T(19))]
    expect(conflictingShiftIds(list).size).toBe(0)
  })
})

describe('coverage — the hole at 02:00 a wall of bars hides', () => {
  const span = { from: ms(T(12)), to: ms(T(16)) }
  const at = (slots: ReturnType<typeof coverage>, iso: string) => slots.find((c) => c.at === ms(iso))!

  it('counts planned people per slot', () => {
    const list = [shift('a', 'p1', T(12), T(14)), shift('b', 'p2', T(12), T(16))]
    const slots = coverage(list, {}, span, ms(T(16)))
    expect(at(slots, T(13)).planned).toBe(2)
    expect(at(slots, T(15)).planned).toBe(1) // p1's shift ended — the gap is visible
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
