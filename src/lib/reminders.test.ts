import { describe, expect, it } from 'vitest'
import { deriveReminders, isDue } from './reminders'
import type { TimelineEvent } from '../types'

// timeline is stored newest-first (App prepends), so fixtures list newest rows first.
const row = (id: string, text: string, reminder: TimelineEvent['reminder'], at = '2026-06-24T03:00:00.000Z'): TimelineEvent =>
  ({ id, t: '03:00', at, icon: 'clock', text, kind: 'reminder', surface: 'map', reminder })

describe('deriveReminders', () => {
  it('returns a created reminder as open with its due time', () => {
    const tl = [row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' })]
    const open = deriveReminders(tl)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ id: 'a', rowId: 'r1', text: 'Lüfter prüfen', dueAt: '2026-06-24T03:10:00.000Z' })
  })

  it('drops a reminder once a later done row references it', () => {
    const tl = [
      row('r2', 'erledigt', { op: 'done', id: 'a' }),
      row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)).toHaveLength(0)
  })

  it('applies the latest snooze as the effective due time', () => {
    const tl = [
      row('r2', '+10', { op: 'snoozed', id: 'a', dueAt: '2026-06-24T03:20:00.000Z' }),
      row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)[0].dueAt).toBe('2026-06-24T03:20:00.000Z')
  })

  it('a snooze without an explicit dueAt keeps the previous due', () => {
    const tl = [
      row('r2', 'snooze', { op: 'snoozed', id: 'a' }),
      row('r1', 'x', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)[0].dueAt).toBe('2026-06-24T03:10:00.000Z')
  })

  it('ignores a malformed created row that has no due', () => {
    const tl = [row('r1', 'x', { op: 'created', id: 'a' })]
    expect(deriveReminders(tl)).toHaveLength(0)
  })

  it('sorts soonest-due first', () => {
    const tl = [
      row('r2', 'later', { op: 'created', id: 'b', dueAt: '2026-06-24T04:00:00.000Z' }),
      row('r1', 'sooner', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('ignores non-reminder rows', () => {
    const tl: TimelineEvent[] = [{ id: 'x', t: '03:00', icon: 'type', text: 'note', kind: 'journal' }]
    expect(deriveReminders(tl)).toHaveLength(0)
  })
})

describe('isDue', () => {
  const r = { id: 'a', rowId: 'r1', text: 'x', dueAt: '2026-06-24T03:10:00.000Z', createdAt: '' }
  it('is false before the due time', () => {
    expect(isDue(r, Date.parse('2026-06-24T03:09:59.000Z'))).toBe(false)
  })
  it('is true at/after the due time', () => {
    expect(isDue(r, Date.parse('2026-06-24T03:10:00.000Z'))).toBe(true)
    expect(isDue(r, Date.parse('2026-06-24T03:11:00.000Z'))).toBe(true)
  })
})

describe('deriveReminders — expired by closure (Einsatzende)', () => {
  const created = (id: string, dueAt: string): TimelineEvent => ({
    id: `row-${id}`, t: '10:00', at: '2026-07-02T10:00:00Z', icon: 'clock', text: id,
    kind: 'reminder', reminder: { op: 'created', id, dueAt },
  })

  it('drops reminders due before closed_at, keeps ones due after', () => {
    const closed = '2026-07-02T18:00:00Z'
    const open = deriveReminders(
      [created('stale', '2026-07-02T12:00:00Z'), created('future', '2026-07-30T09:00:00Z')],
      closed,
    )
    expect(open.map((r) => r.id)).toEqual(['future'])
  })

  it('without a closed_at everything stays open (live incident unchanged)', () => {
    const open = deriveReminders([created('a', '2026-07-02T12:00:00Z')])
    expect(open.map((r) => r.id)).toEqual(['a'])
  })
})
