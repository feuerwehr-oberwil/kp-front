import { describe, expect, it } from 'vitest'
import { visitSchedule } from './visitSchedule'
import type { VisitList } from '../objectVisits/types'

const list = (ref: string, scheduledOn?: string): VisitList => ({ ref, title: ref, scheduledOn, objectIds: ['a'] })

describe('dated rounds', () => {
  it('puts today, overdue and upcoming work in separate groups; retains undated legacy lists', () => {
    const groups = visitSchedule([list('later', '2027-04-03'), list('today', '2027-03-28'), list('late', '2027-03-27'), list('old')], [], '2027-03-28')
    expect(groups.today.map(l => l.ref)).toEqual(['today'])
    expect(groups.overdue.map(l => l.ref)).toEqual(['late'])
    expect(groups.upcoming.map(l => l.ref)).toEqual(['later'])
    expect(groups.undated.map(l => l.ref)).toEqual(['old'])
  })
  it('keeps withdrawn and complete rounds in history, without treating another round as complete', () => {
    const groups = visitSchedule([
      { ...list('cancelled'), archived: true }, list('round'), list('next'),
      { ...list('import'), done: { a: { at: '2026-05-30' } } },
      { ...list('unresolved'), done: { a: { at: '2026-05-30' } }, unresolved: [{ source: 'fwo', id: 'missing' }] },
    ], [{ id: 'visit', objectId: 'a', workRef: 'round', lifecycle: 'completed' }], '2027-03-28')
    expect(groups.history.map(l => l.ref)).toEqual(['cancelled', 'import', 'round'])
    expect(groups.undated.map(l => l.ref)).toEqual(['next', 'unresolved'])
  })
})
