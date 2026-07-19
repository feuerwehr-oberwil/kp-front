import { describe, expect, it } from 'vitest'
import type { Person, Trupp } from '../types'
import { abbreviateName, assignedPersonIds, presentCount, resolvePersonName, resolveTruppNames, rosterFromList } from './personnel'

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

describe('resolveTruppNames', () => {
  const roster = rosterFromList([person('p1', 'Müller Hans'), person('p2', 'Meier Anna')])

  it('uses free-text name/members strings as the snapshot', () => {
    const t = trupp({ name: 'Müller', members: ['Meier', 'Keller'] })
    expect(resolveTruppNames(t, roster)).toEqual({ leader: 'Müller', members: ['Meier', 'Keller'] })
  })
  it('resolves structured ids when strings are absent', () => {
    const t = trupp({ name: '', members: [], leaderPersonId: 'p1', memberPersonIds: ['p2'] })
    expect(resolveTruppNames(t, roster)).toEqual({ leader: 'Müller Hans', members: ['Meier Anna'] })
  })
  it('drops blank member strings', () => {
    const t = trupp({ name: 'Müller', members: ['', '  ', 'Keller'] })
    expect(resolveTruppNames(t, roster).members).toEqual(['Keller'])
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
  it('abbreviates the first name to an initial', () => {
    expect(abbreviateName('Keller Andreas')).toBe('Keller A.')
  })
  it('keeps a multi-word surname intact', () => {
    expect(abbreviateName('Von Arx Beat')).toBe('Von Arx B.')
  })
  it('passes a single token through unchanged', () => {
    expect(abbreviateName('Keller')).toBe('Keller')
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
