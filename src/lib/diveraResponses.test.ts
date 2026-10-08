import { describe, expect, it } from 'vitest'
import { buildAnrueckend, personByDiveraId } from './diveraResponses'
import { FIXTURE, ROSTER } from './diveraResponses.fixture'
import type { DiveraResponses } from './api/divera'
import type { AttendanceState } from '../types'

describe('the «Anrückend» block, as data', () => {
  it('maps Divera users onto the roster through the divera external identity', () => {
    const m = personByDiveraId(ROSTER)
    expect(m.get('103')?.id).toBe('p103')
    expect(m.has('999')).toBe(false)
    expect([...m.values()].some((p) => p.id === 'p200')).toBe(false)
  })

  it('groups coming / not coming / other and counts every answer in the head line', () => {
    const a = buildAnrueckend(FIXTURE, ROSTER, {})!
    expect(a.counts).toEqual({ coming: 4, not_coming: 2, other: 1 })
    expect(a.unanswered).toBe(3)
    // 999 answered «Komme in 10 min» but is not on the Mannschaftsliste — counted, not listed
    expect(a.unmapped).toBe(1)
    expect(a.coming.map((r) => r.person.id)).toEqual(['p101', 'p102', 'p103'])
    expect(a.notComing.map((r) => r.person.displayName)).toEqual(['Huber Lea', 'Weber Marco'])
    expect(a.other.map((r) => r.statusName)).toEqual(['Rückruf erbeten'])
  })

  it('carries the estimate only where the status promises minutes, and never for «kommt nicht»', () => {
    const a = buildAnrueckend(FIXTURE, ROSTER, {})!
    const keller = a.coming.find((r) => r.person.id === 'p103')!
    expect(keller.eta).toBe('2026-10-08T17:11:30+00:00')
    expect(keller.statusName).toBe('Komme in 10 min')
    expect(keller.note).toBe('5 min')
    expect(a.coming.find((r) => r.person.id === 'p101')!.eta).toBeNull()
    expect(a.notComing.every((r) => r.eta === null)).toBe(true)
  })

  it('takes somebody out of the block once they are recorded here — in any state', () => {
    const att: AttendanceState = {
      p101: { status: 'present', displayNameSnapshot: 'Muster Hans', intervals: [{ from: '2026-10-08T17:05:00Z' }] },
      p104: { status: 'left', displayNameSnapshot: 'Huber Lea', intervals: [{ from: '2026-10-08T17:05:00Z', to: '2026-10-08T17:30:00Z' }] },
    }
    const a = buildAnrueckend(FIXTURE, ROSTER, att)!
    expect(a.here).toBe(2)
    expect(a.coming.map((r) => r.person.id)).toEqual(['p102', 'p103'])
    expect(a.notComing.map((r) => r.person.id)).toEqual(['p105'])
    // the head line still counts what Divera said
    expect(a.counts.coming).toBe(4)
  })

  it('is nothing at all without Divera answers', () => {
    expect(buildAnrueckend(null, ROSTER, {})).toBeNull()
    expect(buildAnrueckend({ available: false }, ROSTER, {})).toBeNull()
  })

  it('sorts the soonest arrival first: the estimate where there is one, else the answer time', () => {
    const resp: DiveraResponses = {
      ...FIXTURE,
      answers: [
        { ucr_id: 101, status_id: 12, kind: 'coming', answered_at: '2026-10-08T17:00:00Z', eta: '2026-10-08T17:10:00Z', note: '' },
        { ucr_id: 102, status_id: 11, kind: 'coming', answered_at: '2026-10-08T17:04:00Z', eta: null, note: '' },
      ],
    }
    expect(buildAnrueckend(resp, ROSTER, {})!.coming.map((r) => r.person.id)).toEqual(['p102', 'p101'])
  })
})
