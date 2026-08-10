import { describe, expect, it } from 'vitest'
import type { AttendanceState, Trupp } from '../types'
import { roleConflictHint, rosterFieldRole } from './roleAssignment'

const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't1', name: 'Trupp 2', entryPressureBar: 300, entryTime: '', lastContactTime: '',
  status: 'aktiv', ...over,
})

const present: AttendanceState = {
  p1: { status: 'present', displayNameSnapshot: 'Schmid Peter', intervals: [{ from: '2026-06-23T09:00:00' }] },
}
const left: AttendanceState = {
  p1: {
    status: 'left', displayNameSnapshot: 'Schmid Peter',
    intervals: [{ from: '2026-06-23T09:00:00', to: '2026-06-23T10:00:00' }],
  },
}

describe('roleConflictHint', () => {
  it('says nothing when there is nothing to say', () => {
    expect(roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, [])).toBeUndefined()
    // never recorded at all is not a contradiction — that is the person being added
    expect(roleConflictHint('p1', 'el', 'Schmid Peter', {}, [])).toBeUndefined()
    expect(roleConflictHint(undefined, 'el', '', {}, [])).toBeUndefined()
  })

  it('flags a Fahrer who is under AS — one person in two places', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, [trupp({ memberPersonIds: ['p1'] })])
    expect(hint).toContain('Schmid Peter')
    expect(hint).toContain('AS')
    expect(hint).toContain('Trupp 2')
  })

  it('flags the Einsatzleiter going in with a Trupp — then nobody is leading', () => {
    const hint = roleConflictHint('p1', 'el', 'Schmid Peter', present, [trupp({ leaderPersonId: 'p1' })])
    expect(hint).toContain('Einsatzleiter')
    expect(hint).toContain('Trupp 2')
  })

  it('ignores a Trupp that is already out — that job is over', () => {
    const out = [trupp({ status: 'raus', memberPersonIds: ['p1'] })]
    expect(roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, out)).toBeUndefined()
  })

  it('flags somebody recorded as «gegangen» — one of the two entries is wrong', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', left, [])
    expect(hint).toContain('gegangen')
  })

  it('prefers the Trupp conflict over the departure — the Trupp is the sharper one', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', left, [trupp({ memberPersonIds: ['p1'] })])
    expect(hint).toContain('Trupp 2')
  })
})

describe('rosterFieldRole', () => {
  it('names the vehicle a Fahrer drives', () => {
    expect(rosterFieldRole('VKF Fahrzeug', 'Fahrer', 'TLF 1')).toEqual({ role: 'fahrer', note: 'Fahrer TLF 1' })
  })

  it('an unnamed vehicle still says «Fahrer», with nothing trailing it', () => {
    expect(rosterFieldRole('VKF Fahrzeug', 'Fahrer', undefined)).toEqual({ role: 'fahrer', note: 'Fahrer' })
  })

  it('the Einsatzleiter glyph writes the function — Name leads, Stv. deputises', () => {
    expect(rosterFieldRole('VKF Einsatzleiter', 'Name', undefined)).toEqual({ role: 'el', note: 'Einsatzleiter' })
    // the deputy used to land on the Anwesenheit list with an empty Bemerkung
    expect(rosterFieldRole('VKF Einsatzleiter', 'Stv.', undefined)).toEqual({ role: 'el', note: 'Stv. Einsatzleiter' })
  })

  it('a «Name» on any other symbol marks the person present without inventing a job', () => {
    expect(rosterFieldRole('VKF Drehleiter', 'Name', 'ADL')).toEqual({ role: 'fahrer' })
  })
})
