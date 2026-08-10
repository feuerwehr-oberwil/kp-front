import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Person, Trupp } from '../types'

// The station's name order decides which token abbreviateName treats as the given name.
// Default is the shipped one; the first-last case flips it for a single test.
let nameOrder: 'last-first' | 'first-last' = 'last-first'
vi.mock('./deploymentConfig', () => ({ rosterNameOrder: () => nameOrder }))
afterEach(() => { nameOrder = 'last-first' })

import { abbreviateName, assignedPersonIds, presentCount, resolvePersonName, linkTrupps, rosterFromList, rosterIdByName, truppSlots } from './personnel'

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

// A Trupp joins the Mannschaft on IDS — but two shapes reach this function without them, and the
// stored record cannot tell them apart. Both used to end with roster members badged «Gast».
describe('truppSlots (the Trupp as the form reads it)', () => {
  const people: Person[] = [
    { id: 'p1', displayName: 'Weber Marco', active: true, updatedAt: '' },
    { id: 'p2', displayName: 'Huber Sarah', active: true, updatedAt: '' },
    { id: 'p3', displayName: 'Baumann Michael', active: true, updatedAt: '' },
  ]
  const byName = rosterIdByName(people)
  const roster = rosterFromList(people)
  const trupp = (over: Partial<Trupp>): Trupp => ({
    id: 'T1', name: 'Weber Marco', entryPressureBar: 300, entryTime: '', lastContactTime: '',
    status: 'angemeldet', ...over,
  })

  it('re-links a Trupp that carries only names', () => {
    const out = truppSlots(trupp({ members: ['Huber Sarah', 'Baumann Michael'] }), byName, roster)
    expect(out.map((s) => s.personId)).toEqual(['p1', 'p2', 'p3'])
  })

  it('⚠️ refuses a positional id the roster says belongs to somebody else', () => {
    // memberPersonIds is written .filter(Boolean) but read positionally, so [Gast, Huber]
    // stores ['p2'] — and slot 0, the Gast, used to adopt Sarah Huber's id.
    const out = truppSlots(trupp({ members: ['Muster Felix (Nachbarwehr)', 'Huber Sarah'], memberPersonIds: ['p2'] }), byName, roster)
    expect(out[1]).toEqual({ name: 'Muster Felix (Nachbarwehr)', personId: undefined })
    expect(out[2].personId).toBe('p2')
  })

  it('never invents a roster row for a real Gast', () => {
    const out = truppSlots(trupp({ name: 'Muster Felix (Nachbarwehr)' }), byName, roster)
    expect(out).toEqual([{ name: 'Muster Felix (Nachbarwehr)', personId: undefined }])
  })

  it('keeps an explicit link that already agrees with the name', () => {
    const out = truppSlots(trupp({ leaderPersonId: 'p1', members: ['Huber Sarah'], memberPersonIds: ['p2'] }), byName, roster)
    expect(out.map((s) => s.personId)).toEqual(['p1', 'p2'])
  })

  it('matches the way a name is actually retyped — trimmed and case-folded', () => {
    expect(truppSlots(trupp({ name: '  weber marco ' }), byName, roster)[0].personId).toBe('p1')
  })

  it('drops empty slots, leader first', () => {
    const out = truppSlots(trupp({ members: ['', '  ', 'Huber Sarah'] }), byName, roster)
    expect(out.map((s) => s.name)).toEqual(['Weber Marco', 'Huber Sarah'])
  })
})

// The three answers to «who is already committed» are computed from IDS, so a Trupp carrying only
// names was invisible to all of them at once — no «unter AS» on the Fahrer picker, no locked
// Anwesenheit row, no «einer, ein Trupp».
describe('linkTrupps (reading name-only Trupps through the roster)', () => {
  const people: Person[] = [
    { id: 'p1', displayName: 'Weber Marco', active: true, updatedAt: '' },
    { id: 'p2', displayName: 'Huber Sarah', active: true, updatedAt: '' },
  ]
  const byName = rosterIdByName(people)
  const roster = rosterFromList(people)
  const nameOnly: Trupp = {
    id: 'T1', name: 'Weber Marco', members: ['Huber Sarah'], entryPressureBar: 300,
    entryTime: '', lastContactTime: '', status: 'aktiv',
  }

  it('makes a name-only Trupp answer assignedPersonIds', () => {
    expect(assignedPersonIds([nameOnly])).toEqual(new Set())
    expect(assignedPersonIds(linkTrupps([nameOnly], byName, roster))).toEqual(new Set(['p1', 'p2']))
  })

  it('returns the SAME array when nothing needed linking — the memo downstream must not churn', () => {
    const linked = linkTrupps([nameOnly], byName, roster)
    expect(linkTrupps(linked, byName, roster)).toBe(linked)
  })

  it('is a no-op without a roster to resolve against', () => {
    const ts = [nameOnly]
    expect(linkTrupps(ts, new Map(), roster)).toBe(ts)
  })

  it('leaves a real Gast unlinked', () => {
    const guest: Trupp = { ...nameOnly, name: 'Muster Felix (Nachbarwehr)', members: [] }
    expect(assignedPersonIds(linkTrupps([guest], byName, roster))).toEqual(new Set())
  })
})
