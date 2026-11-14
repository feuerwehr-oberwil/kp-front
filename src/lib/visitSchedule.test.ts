import { describe, expect, it } from 'vitest'
import { listClosed, visitSchedule } from './visitSchedule'
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
  it('keeps withdrawn and complete rounds out of the work groups, without treating another round as complete', () => {
    const groups = visitSchedule([
      { ...list('cancelled'), archived: true }, list('round'), list('next'),
      { ...list('import'), done: { a: { at: '2026-05-30' } } },
      { ...list('unresolved'), done: { a: { at: '2026-05-30' } }, unresolved: [{ source: 'fwo', id: 'missing' }] },
    ], [{ id: 'visit', objectId: 'a', workRef: 'round', lifecycle: 'completed', visitedAt: '2027-01-10T09:00:00Z' }], '2027-03-28')
    expect(groups.history.map(l => l.ref)).toEqual(['cancelled', 'import', 'round'])
    expect(groups.recent).toEqual([])
    expect(groups.undated.map(l => l.ref)).toEqual(['next', 'unresolved'])
  })
  it('shows a round finished in the last week as recent, then lets it go to history', () => {
    const lists = [
      list('this-week', '2027-03-25'), list('last-month', '2027-02-20'),
      { ...list('withdrawn'), archived: true },
      { ...list('organizer'), done: { a: { at: '2027-03-21' } } },
    ]
    const visits = [
      { id: 'v1', objectId: 'a', workRef: 'this-week', lifecycle: 'completed', visitedAt: '2027-03-25T17:00:00Z' },
      { id: 'v2', objectId: 'a', workRef: 'last-month', lifecycle: 'completed', visitedAt: '2027-02-20T17:00:00Z' },
      { id: 'v3', objectId: 'a', workRef: 'withdrawn', lifecycle: 'completed', visitedAt: '2027-03-27T17:00:00Z' },
    ]
    const groups = visitSchedule(lists, visits, '2027-03-28')
    expect(groups.recent.map(l => l.ref)).toEqual(['this-week', 'organizer'])
    expect(groups.history.map(l => l.ref)).toEqual(['last-month', 'withdrawn'])
    expect(visitSchedule(lists, visits, '2027-04-01').recent.map(l => l.ref)).toEqual(['this-week'])
  })
  it('keeps an organizer completion dated in the future out of recent, and reads a timestamp by its day', () => {
    const groups = visitSchedule([
      { ...list('future'), done: { a: { at: '2027-04-02' } } },
      { ...list('stamped'), done: { a: { at: '2027-03-28T15:00:00Z' } } },
    ], [], '2027-03-28')
    expect(groups.recent.map(l => l.ref)).toEqual(['stamped'])
    expect(groups.history.map(l => l.ref)).toEqual(['future'])
  })
  it('sends a round past its closesAt to history, complete or not; one still open goes where its day says', () => {
    const now = Date.parse('2027-03-28T10:00:00+01:00')
    const evening = (ref: string, day: string): VisitList => ({ ...list(ref, day), closesAt: `${day}T23:59:59+01:00` })
    const lists = [evening('last-week', '2027-03-23'), evening('done-last-night', '2027-03-27'), evening('tonight', '2027-03-28'), evening('next-week', '2027-04-04')]
    const visits = [{ id: 'v', objectId: 'a', workRef: 'done-last-night', lifecycle: 'completed', visitedAt: '2027-03-27T19:00:00Z' }]
    const groups = visitSchedule(lists, visits, '2027-03-28', now)
    expect(groups.history.map(l => l.ref)).toEqual(['done-last-night', 'last-week'])
    expect(groups.recent).toEqual([])
    expect(groups.overdue).toEqual([])
    expect(groups.today.map(l => l.ref)).toEqual(['tonight'])
    expect(groups.upcoming.map(l => l.ref)).toEqual(['next-week'])
    // the field app reads «closed» the same way to stop new captures
    expect(lists.map(l => listClosed(l, now))).toEqual([true, true, false, false])
  })
})
