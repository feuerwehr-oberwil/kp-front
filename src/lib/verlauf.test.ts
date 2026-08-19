import { describe, expect, it } from 'vitest'
import { groupByDay, isHandWritten, isNachtrag, rowTime, rowPhotos, swapUrl, repeatRuns } from './verlauf'
import type { TimelineEvent } from '../types'

const row = (id: string, at?: string): TimelineEvent =>
  ({ id, t: '09:00', at, icon: 'flag', text: id })

const NOW = new Date('2026-07-02T15:00:00')

describe('groupByDay', () => {
  it('keeps a single-day (today) journal as one unlabeled group', () => {
    const g = groupByDay([row('b', '2026-07-02T14:00:00'), row('a', '2026-07-02T09:00:00')], NOW)
    expect(g).toHaveLength(1)
    expect(g[0].label).toBeNull()
    expect(g[0].events.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('separates calendar days and labels the older ones', () => {
    const g = groupByDay(
      [row('new', '2026-07-02T10:00:00'), row('mid', '2026-07-01T22:00:00'), row('old', '2026-06-10T08:00:00')],
      NOW,
    )
    expect(g).toHaveLength(3)
    expect(g[0].label).toBeNull() // today
    expect(g[1].label).toMatch(/01\.07\.2026|07\/01\/2026|2026/)
    expect(g[2].label).toMatch(/10\.06\.2026|06\/10\/2026|2026/)
  })

  it('rows without `at` (old data) stick to the running group instead of fragmenting', () => {
    const g = groupByDay([row('a', '2026-07-02T10:00:00'), row('legacy'), row('b', '2026-07-02T08:00:00')], NOW)
    expect(g).toHaveLength(1)
    expect(g[0].events.map((e) => e.id)).toEqual(['a', 'legacy', 'b'])
  })
})

describe('isNachtrag', () => {
  const closed = '2026-07-02T18:00:00Z'
  it('flags rows after the Einsatzende, not rows during the incident', () => {
    expect(isNachtrag(row('during', '2026-07-02T14:00:00Z'), closed)).toBe(false)
    expect(isNachtrag(row('after', '2026-07-20T10:00:00Z'), closed)).toBe(true)
    expect(isNachtrag(row('after', '2026-07-20T10:00:00Z'), null)).toBe(false) // never closed
    expect(isNachtrag(row('no-at'), closed)).toBe(false) // legacy rows can't be judged
  })
})

describe('rowTime', () => {
  it('localises from `at` when present (server rows ship t="")', () => {
    const t = rowTime({ ...row('x', '2026-07-02T14:05:00'), t: '' })
    expect(t).toMatch(/14:05|02:05/) // local vs 12h formats
  })
  it('falls back to the baked t for legacy rows', () => {
    expect(rowTime(row('x'))).toBe('09:00')
  })
})

// Several pictures on one row: attaching a second used to REPLACE the first. Rows written
// before 2026-08-06 carry a single `photoUrl`, so every reader has to take both shapes.
describe('rowPhotos / swapUrl', () => {
  it('reads the new list, the old single field, and neither', () => {
    expect(rowPhotos({ photoUrls: ['/a', '/b'] })).toEqual(['/a', '/b'])
    expect(rowPhotos({ photoUrl: '/legacy' })).toEqual(['/legacy'])
    expect(rowPhotos({})).toEqual([])
    // a list wins over the legacy field (a patched row can carry both)
    expect(rowPhotos({ photoUrl: '/legacy', photoUrls: ['/a'] })).toEqual(['/a'])
  })

  it('swaps ONE uploaded picture and leaves the others alone', () => {
    expect(swapUrl(['blob:1', 'blob:2'], 'blob:2', '/api/media/2')).toEqual(['blob:1', '/api/media/2'])
  })

  it('appends when the local url is already gone (a late upload must not vanish)', () => {
    expect(swapUrl(['/api/media/1'], 'blob:gone', '/api/media/2')).toEqual(['/api/media/1', '/api/media/2'])
    expect(swapUrl(undefined, 'blob:gone', '/api/media/2')).toEqual(['/api/media/2'])
  })
})

describe('isHandWritten', () => {
  const e = (over: Partial<TimelineEvent>): TimelineEvent =>
    ({ id: 'x', t: '', at: '2026-08-18T10:00:00.000Z', icon: 'type', text: 'x', ...over })

  it('takes everything the composer writes', () => {
    expect(isHandWritten(e({ kind: 'journal', icon: 'type' }))).toBe(true)
    expect(isHandWritten(e({ kind: 'audio', icon: 'mic' }))).toBe(true)
    expect(isHandWritten(e({ kind: 'photo', icon: 'photo' }))).toBe(true)
  })

  // ⚠️ the app reporting an action — rewriting one of these would make the record state
  // something that did not happen
  it('takes nothing the app wrote about an action', () => {
    expect(isHandWritten(e({ kind: 'team', icon: 'people' }))).toBe(false)
    expect(isHandWritten(e({ kind: 'symbol', icon: 'pin' }))).toBe(false)
    expect(isHandWritten(e({ kind: 'reminder', icon: 'clock' }))).toBe(false)
    // ⚠️ a Checklisten-Haken IS kind 'journal' — the icon is what separates it
    expect(isHandWritten(e({ kind: 'journal', icon: 'check' }))).toBe(false)
  })
})

// A state the app re-states («Trupp X überfällig» every few seconds while nothing changes, an
// undo tapped six times in two seconds) is one line that repeated — not twenty lines. Display
// only: every row stays in the record, and the count is shown rather than swallowed.
describe('repeatRuns', () => {
  const row = (id: string, at: string, text: string, over: Partial<TimelineEvent> = {}): TimelineEvent =>
    ({ id, t: at.slice(11, 16), at, icon: 'warn', text, kind: 'team', ...over })

  it('collapses a run of the same line into the first, counting the repeats', () => {
    const rows = [
      row('a', '2026-08-19T20:00:00.000Z', 'Atemschutz-Alarm: Trupp Weber Marco – Überfällig'),
      row('b', '2026-08-19T20:00:05.000Z', 'Atemschutz-Alarm: Trupp Weber Marco – Überfällig'),
      row('c', '2026-08-19T20:00:11.000Z', 'Atemschutz-Alarm: Trupp Weber Marco – Überfällig'),
    ]
    const { counts, hidden } = repeatRuns(rows)
    expect(hidden).toEqual(new Set(['b', 'c']))
    expect(counts.get('a')).toBe(3)
  })

  // two Trupps pinging alternately are two runs, not one — each keeps its own first line
  it('keeps interleaved runs apart', () => {
    const rows = [
      row('a1', '2026-08-19T20:00:00.000Z', 'Alarm: Weber'),
      row('b1', '2026-08-19T20:00:01.000Z', 'Alarm: Müller'),
      row('a2', '2026-08-19T20:00:06.000Z', 'Alarm: Weber'),
      row('b2', '2026-08-19T20:00:07.000Z', 'Alarm: Müller'),
    ]
    const { counts, hidden } = repeatRuns(rows)
    expect(hidden).toEqual(new Set(['a2', 'b2']))
    expect(counts.get('a1')).toBe(2)
    expect(counts.get('b1')).toBe(2)
  })

  // ⚠️ the SECOND turnus is news. A line that comes back after the window is its own row, so a
  // Trupp that went overdue again after a Funkkontakt can never be hidden behind the first alarm.
  it('never collapses across a gap longer than the window', () => {
    const rows = [
      row('a', '2026-08-19T20:00:00.000Z', 'Atemschutz-Alarm: Trupp Weber Marco – Überfällig'),
      row('b', '2026-08-19T20:07:00.000Z', 'Atemschutz-Alarm: Trupp Weber Marco – Überfällig'),
    ]
    const { counts, hidden } = repeatRuns(rows)
    expect(hidden.size).toBe(0)
    expect(counts.size).toBe(0)
  })

  it('leaves hand-written rows alone — somebody who typed it twice meant it twice', () => {
    const rows = [
      row('a', '2026-08-19T20:00:00.000Z', 'Wasser marsch', { kind: 'journal', icon: 'type' }),
      row('b', '2026-08-19T20:00:04.000Z', 'Wasser marsch', { kind: 'journal', icon: 'type' }),
    ]
    expect(repeatRuns(rows).hidden.size).toBe(0)
  })
})
