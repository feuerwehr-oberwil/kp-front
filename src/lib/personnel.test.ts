import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Person, Trupp } from '../types'

// The station's name order decides which token abbreviateName treats as the given name.
// Default is the shipped one; the first-last case flips it for a single test.
let nameOrder: 'last-first' | 'first-last' = 'last-first'
vi.mock('./deploymentConfig', () => ({ rosterNameOrder: () => nameOrder }))
afterEach(() => { nameOrder = 'last-first' })

import { abbreviateName, assignedPersonIds, presentCount, resolvePersonName, rosterFromList } from './personnel'

const person = (id: string, displayName: string, active = true): Person => ({ id, displayName, active, updatedAt: '2026-06-23T10:00:00Z' })

const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't1', name: '', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', ...over,
})

describe('resolvePersonName', () => {
  const roster = rosterFromList([person('p1', 'Müller Hans')])

  it('prefers the snapshot over the roster (historical stability)', () => {
    expect(resolvePersonName(roster, 'p1', 'Müller H. (alt)')).toBe('Müller H. (alt)')
  })
  it('falls back to current roster name when no snapshot', () => {
    expect(resolvePersonName(roster, 'p1')).toBe('Müller Hans')
  })
  it('falls back to the id when person is unknown', () => {
    expect(resolvePersonName(roster, 'ghost')).toBe('ghost')
  })
  it('returns empty string when nothing is given', () => {
    expect(resolvePersonName(roster)).toBe('')
  })
})

describe('assignedPersonIds', () => {
  it('collects leader + member ids from non-exited trupps', () => {
    const ids = assignedPersonIds([
      trupp({ id: 'a', leaderPersonId: 'p1', memberPersonIds: ['p2'], status: 'aktiv' }),
      trupp({ id: 'b', leaderPersonId: 'p3', status: 'raus' }), // exited → ignored
    ])
    expect([...ids].sort()).toEqual(['p1', 'p2'])
  })
})

describe('abbreviateName', () => {
  // the roster spells names in the station's configured order; the label always reads
  // surname-first, the way a Feuerwehr calls people
  it('puts the surname first and the given name to an initial', () => {
    expect(abbreviateName('Keller Andreas')).toBe('Keller A.')
    expect(abbreviateName('Meier Anna')).toBe('Meier A.')
  })
  it('keeps a multi-word surname intact', () => {
    expect(abbreviateName('Von Arx Beat')).toBe('Von Arx B.')
  })
  it('passes a single token through unchanged', () => {
    expect(abbreviateName('Keller')).toBe('Keller')
  })

  it('reads the given name off the OTHER end for a «Vorname Nachname» station', () => {
    nameOrder = 'first-last'
    expect(abbreviateName('Andreas Keller')).toBe('Keller A.')
    expect(abbreviateName('Beat Von Arx')).toBe('Von Arx B.')
  })
})

describe('presentCount', () => {
  it('counts only present entries', () => {
    expect(presentCount({
      p1: { status: 'present', displayNameSnapshot: 'Müller Hans' },
      p2: { status: 'left', displayNameSnapshot: 'Meier Anna' },
    })).toBe(1)
  })
})
