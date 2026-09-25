import { describe, expect, it } from 'vitest'
import { derivedCrewGuestId, unfiledTruppCrew } from './crewFiling'
import type { AttendanceState, Trupp } from '../types'
import { appConfig } from '../config/appConfig'

const A = appConfig.copy.anwesenheit
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't1', name: 'Muster Leo', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', ...over,
})
const present = (name: string): AttendanceState[string] =>
  ({ status: 'present', displayNameSnapshot: name, intervals: [{ from: '2026-09-25T10:00:00Z' }] }) as unknown as AttendanceState[string]
const noRoster = () => undefined

describe('unfiledTruppCrew — what an editor device files for a Link-registered crew', () => {
  it('files two typed Gäste under ids every device derives the same way, leader with the GF note', () => {
    const [f] = unfiledTruppCrew([trupp({ members: ['Frei Nora'] })], {}, noRoster)
    expect(f.entries).toEqual([
      { id: derivedCrewGuestId('t1', 'Muster Leo'), name: 'Muster Leo', note: expect.stringContaining(A.roleAtemschutz) },
      { id: derivedCrewGuestId('t1', 'Frei Nora'), name: 'Frei Nora', note: A.roleAtemschutz },
    ])
    expect(f.groupTemplate).toBe(A.logRoleGroup)
    // …and the row id is the same on a second device that sees the same Trupp
    expect(unfiledTruppCrew([trupp({ members: ['Frei Nora'] })], {}, noRoster)[0].rowId).toBe(f.rowId)
  })

  it('marks a picked roster person present under their own id', () => {
    const [f] = unfiledTruppCrew([trupp({ leaderPersonId: 'p1' })], {}, noRoster)
    expect(f.entries).toEqual([expect.objectContaining({ id: 'p1', name: 'Muster Leo' })])
  })

  it('files nobody twice: already on the list by id, or by the same name (a Gast from an editor device)', () => {
    expect(unfiledTruppCrew([trupp({ leaderPersonId: 'p1' })], { p1: present('Muster Leo') }, noRoster)).toEqual([])
    expect(unfiledTruppCrew([trupp({})], { gX: present('Muster Leo') }, noRoster)).toEqual([])
    const derived = derivedCrewGuestId('t1', 'Muster Leo')
    expect(unfiledTruppCrew([trupp({})], { [derived]: present('Muster Leo') }, noRoster)).toEqual([])
  })

  it('resolves a typed name to the roster, and leaves a Trupp taken off the board alone', () => {
    const [f] = unfiledTruppCrew([trupp({})], {}, (n) => (n === 'Muster Leo' ? 'p7' : undefined))
    expect(f.entries[0].id).toBe('p7')
    expect(unfiledTruppCrew([trupp({ removedAt: '2026-09-25T11:00:00Z' })], {}, noRoster)).toEqual([])
  })
})
