import { describe, expect, it } from 'vitest'
import type { AttendanceEntry, AttendanceState } from '../types'
import { ortCounts, ortOf, otherOrt } from './attendanceOrt'

const present = (over: Partial<AttendanceEntry> = {}): AttendanceEntry => ({
  status: 'present', displayNameSnapshot: 'Meier Anna',
  intervals: [{ from: '2026-08-08T22:11:00Z' }], ...over,
})
const left = (over: Partial<AttendanceEntry> = {}): AttendanceEntry => ({
  status: 'left', displayNameSnapshot: 'Huber Sarah',
  intervals: [{ from: '2026-08-08T22:11:00Z', to: '2026-08-08T23:00:00Z' }], ...over,
})

describe('ortOf', () => {
  it('⚠️ reads an entry with no Ort as «vor Ort» — every record written before this existed', () => {
    // «anwesend» meant «here»; reading those as Magazin would rewrite every closed Einsatz
    expect(ortOf(present())).toBe('scene')
    expect(ortOf(undefined)).toBe('scene')
  })

  it('reads what was recorded once somebody said it', () => {
    expect(ortOf(present({ ort: 'station' }))).toBe('station')
    expect(ortOf(present({ ort: 'scene' }))).toBe('scene')
  })
})

describe('otherOrt', () => {
  it('is the whole of «what does a tap do»', () => {
    expect(otherOrt('scene')).toBe('station')
    expect(otherOrt('station')).toBe('scene')
  })
})

describe('ortCounts', () => {
  it('counts only the people who are HERE — somebody who went home is at neither', () => {
    const attendance: AttendanceState = {
      a: present({ ort: 'scene' }),
      b: present({ ort: 'station' }),
      c: present({ ort: 'station' }),
      d: present(), // no Ort recorded → vor Ort
      e: left({ ort: 'station' }), // gone home, counted nowhere
    }
    expect(ortCounts(attendance)).toEqual({ scene: 2, station: 2 })
  })

  it('is all zeros on an empty Anwesenheit', () => {
    expect(ortCounts({})).toEqual({ scene: 0, station: 0 })
  })
})
