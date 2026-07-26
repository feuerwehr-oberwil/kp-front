import { describe, expect, it } from 'vitest'
import {
  closePresence, currentIntervalIndex, intervalsOf, isPresent, openPresence, setIntervalTime, totalMinutes,
} from './attendanceIntervals'
import type { AttendanceEntry } from '../types'

const ALARM = '2026-07-26T12:00:00.000Z'
const T = (h: number, m = 0) => `2026-07-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`

describe('legacy entries (written before blocks existed)', () => {
  it('projects its single pair, so every reader sees one shape', () => {
    const legacy: AttendanceEntry = { status: 'left', checkedInAt: T(14), leftAt: T(18), displayNameSnapshot: 'Meier' }
    expect(intervalsOf(legacy)).toEqual([{ from: T(14), to: T(18) }])
    expect(isPresent(legacy)).toBe(false)
  })

  it('projects an open pair as an open block', () => {
    const legacy: AttendanceEntry = { status: 'present', checkedInAt: T(14), displayNameSnapshot: 'Meier' }
    expect(intervalsOf(legacy)).toEqual([{ from: T(14) }])
    expect(isPresent(legacy)).toBe(true)
  })

  it('has no block at all when it never carried a time', () => {
    expect(intervalsOf({ status: 'left', displayNameSnapshot: 'Meier' })).toEqual([])
    expect(intervalsOf(undefined)).toEqual([])
  })

  // real rows on prod: a second «anwesend» used to keep the earlier leftAt, so the person was
  // marked present AND carried a departure. Status is the operational truth — they are here.
  it('keeps the old half-state (present WITH a stale leftAt) on the board', () => {
    const halfState: AttendanceEntry = { status: 'present', checkedInAt: T(14), leftAt: T(18), displayNameSnapshot: 'Meier' }
    expect(isPresent(halfState)).toBe(true)
    expect(intervalsOf(halfState)).toEqual([{ from: T(14) }]) // stale departure dropped
  })

  it('does not put a legacy «gegangen» row without a leftAt back on the board', () => {
    const noEnd: AttendanceEntry = { status: 'left', checkedInAt: T(14), displayNameSnapshot: 'Meier' }
    expect(isPresent(noEnd)).toBe(false)
  })

  it('lets the blocks decide once an entry has them, whatever status says', () => {
    const stale: AttendanceEntry = {
      status: 'left', displayNameSnapshot: 'Meier', checkedInAt: T(14),
      intervals: [{ from: T(14), to: T(18) }, { from: T(22) }],
    }
    expect(isPresent(stale)).toBe(true)
  })
})

describe('opening and closing blocks', () => {
  it('opens the first block at the given time (the alarm time, not now)', () => {
    const e = openPresence(undefined, ALARM, 'Meier')
    expect(e.status).toBe('present')
    expect(e.checkedInAt).toBe(ALARM)
    expect(e.leftAt).toBeUndefined()
    expect(e.intervals).toEqual([{ from: ALARM }])
  })

  it('is a no-op while a block is already open (a double tap can\'t fragment the record)', () => {
    const once = openPresence(undefined, ALARM, 'Meier')
    expect(openPresence(once, T(15), 'Meier').intervals).toEqual([{ from: ALARM }])
  })

  it('closes the open block and leaves the person gegangen', () => {
    const e = closePresence(openPresence(undefined, ALARM, 'Meier'), T(18))
    expect(e.status).toBe('left')
    expect(e.leftAt).toBe(T(18))
    expect(e.intervals).toEqual([{ from: ALARM, to: T(18) }])
  })

  it('will not close what is already closed', () => {
    const closed = closePresence(openPresence(undefined, ALARM, 'Meier'), T(18))
    expect(closePresence(closed, T(20))).toBe(closed)
  })
})

describe('come, leave, come again — the case the single pair could not hold', () => {
  const meier = () => {
    const first = closePresence(openPresence(undefined, T(14), 'Meier'), T(18))
    return openPresence(first, T(22), 'Meier')
  }

  it('keeps both blocks, each with its own von–bis', () => {
    expect(meier().intervals).toEqual([{ from: T(14), to: T(18) }, { from: T(22) }])
  })

  it('re-derives the summary: first arrival, and NO departure while they are back', () => {
    const e = meier()
    expect(e.status).toBe('present')
    expect(e.checkedInAt).toBe(T(14))
    expect(e.leftAt).toBeUndefined() // the 18:00 departure lives on in the block, not the summary
  })

  it('reports the last departure again once the second block closes', () => {
    const e = closePresence(meier(), T(2))
    expect(e.status).toBe('left')
    expect(e.checkedInAt).toBe(T(14))
    expect(e.leftAt).toBe(T(2))
  })
})

describe('corrections', () => {
  it('patches the addressed block and re-derives around it', () => {
    const two = openPresence(closePresence(openPresence(undefined, T(14), 'Meier'), T(18)), T(22), 'Meier')
    const fixed = setIntervalTime(two, 0, { from: T(13, 30) })
    expect(fixed.intervals?.[0]).toEqual({ from: T(13, 30), to: T(18) })
    expect(fixed.checkedInAt).toBe(T(13, 30))
    expect(fixed.intervals?.[1]).toEqual({ from: T(22) }) // untouched
  })

  it('ignores an index that does not exist', () => {
    const one = openPresence(undefined, T(14), 'Meier')
    expect(setIntervalTime(one, 7, { from: T(9) })).toBe(one)
  })

  it('points a correction at the open block, else the last closed one', () => {
    const open = openPresence(closePresence(openPresence(undefined, T(14), 'M'), T(18)), T(22), 'M')
    expect(currentIntervalIndex(open)).toBe(1)
    expect(currentIntervalIndex(closePresence(open, T(2)))).toBe(1)
    expect(currentIntervalIndex(undefined)).toBe(0)
  })
})

describe('minutes actually served', () => {
  const opts = { alarmedAt: ALARM, endedAt: T(23) }

  it('sums the blocks — the hours spent AWAY are not billed', () => {
    // 14–18 (240) + 22–23 (60) = 300, NOT 14→23 = 540
    const two = openPresence(closePresence(openPresence(undefined, T(14), 'M'), T(18)), T(22), 'M')
    expect(totalMinutes(intervalsOf(two), opts)).toBe(300)
  })

  it('falls back to Alarmierung / Einsatzende, as it always did', () => {
    expect(totalMinutes([], opts)).toBe(11 * 60)
    expect(totalMinutes([{ from: T(14) }], opts)).toBe(9 * 60)
  })

  it('is null rather than quietly short when an end cannot be resolved', () => {
    expect(totalMinutes([{ from: T(14) }], { alarmedAt: ALARM, endedAt: null })).toBeNull()
  })

  it('never counts a corrected-backwards block as negative time', () => {
    expect(totalMinutes([{ from: T(18), to: T(14) }], opts)).toBe(0)
  })
})
