import { describe, expect, it } from 'vitest'
import { changedAttendanceNames } from './attendanceDiff'
import type { AttendanceEntry, Person } from '../types'

const entry = (displayNameSnapshot: string, from = '2026-08-17T20:00:00.000Z'): AttendanceEntry =>
  ({ status: 'present', displayNameSnapshot, intervals: [{ from }] })
const roster = new Map<string, Person>([['p1', { id: 'p1', displayName: 'Hofer Simon', active: true, updatedAt: '2026-08-17T20:00:00.000Z' }]])

describe('changedAttendanceNames', () => {
  it('names the person a step moved, and nobody else', () => {
    const untouched = entry('Meier Anna')
    expect(changedAttendanceNames(
      { p1: entry('Hofer Simon'), p2: untouched },
      { p2: untouched },
      roster,
    )).toEqual(['Hofer Simon'])
  })

  it('reads a guest off the entry itself — there is no roster row to ask', () => {
    expect(changedAttendanceNames({}, { g1: entry('Brunner (Gast)') }, roster)).toEqual(['Brunner (Gast)'])
  })

  it('says nothing when the two states hold the same list', () => {
    const same = { p1: entry('Hofer Simon') }
    expect(changedAttendanceNames(same, { p1: entry('Hofer Simon') }, roster)).toEqual([])
    expect(changedAttendanceNames(same, same, roster)).toEqual([])
  })

  it('notices a changed time on an otherwise identical row', () => {
    expect(changedAttendanceNames(
      { p1: entry('Hofer Simon', '2026-08-17T20:00:00.000Z') },
      { p1: entry('Hofer Simon', '2026-08-17T20:05:00.000Z') },
      roster,
    )).toEqual(['Hofer Simon'])
  })
})
