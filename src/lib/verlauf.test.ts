import { describe, expect, it } from 'vitest'
import { groupByDay, isHandWritten, isNachtrag, rowText, rowTime, rowPhotos, swapUrl, repeatRuns } from './verlauf'
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

  it('reports when a run stopped, so «6×» can be told from «6× over two minutes»', () => {
    const { counts, lastAt } = repeatRuns([
      row('a', '2026-09-01T14:32:00.000Z', 'Kontakt überfällig'),
      row('b', '2026-09-01T14:32:40.000Z', 'Kontakt überfällig'),
      row('c', '2026-09-01T14:33:10.000Z', 'Kontakt überfällig'),
    ])
    expect(counts.get('a')).toBe(3)
    expect(lastAt.get('a')).toBe('2026-09-01T14:33:10.000Z')
  })

  it('leaves lastAt empty for a line that never repeated', () => {
    const { lastAt } = repeatRuns([row('a', '2026-09-01T14:32:00.000Z', 'Kontakt überfällig')])
    expect(lastAt.has('a')).toBe(false)
  })

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

  // ⚠️ SAME TEXT, DIFFERENT OBJECT is not a repeat. Two Notizen dropped in the same breath
  // both log «Notiz gesetzt»; keying on the sentence alone printed «Notiz gesetzt 2×» and lost one
  // of the two notes from the Verlauf and from the printed Rapport.
  it('never merges the same sentence about two different objects', () => {
    const rows = [
      row('n1', '2026-08-19T20:00:00.000Z', 'Notiz gesetzt', { kind: 'symbol', entityId: 'e100' }),
      row('n2', '2026-08-19T20:00:03.000Z', 'Notiz gesetzt', { kind: 'symbol', entityId: 'e200' }),
    ]
    const { counts, hidden } = repeatRuns(rows)
    expect(hidden.size).toBe(0)
    expect(counts.size).toBe(0)
  })

  // …the board's side of the same key: two shapes drawn in one burst are two annotations
  it('never merges the same sentence about two different plan annotations', () => {
    const rows = [
      row('a1', '2026-08-19T20:00:00.000Z', 'Fläche gezeichnet', { kind: 'symbol', annoId: 'sh1' }),
      row('a2', '2026-08-19T20:00:02.000Z', 'Fläche gezeichnet', { kind: 'symbol', annoId: 'sh2' }),
    ]
    expect(repeatRuns(rows).hidden.size).toBe(0)
  })

  it('still collapses a run about ONE object', () => {
    const rows = [
      row('n1', '2026-08-19T20:00:00.000Z', 'Notiz gesetzt', { kind: 'symbol', entityId: 'e100' }),
      row('n2', '2026-08-19T20:00:03.000Z', 'Notiz gesetzt', { kind: 'symbol', entityId: 'e100' }),
      row('n3', '2026-08-19T20:00:06.000Z', 'Notiz gesetzt', { kind: 'symbol', entityId: 'e100' }),
    ]
    const { counts, hidden } = repeatRuns(rows)
    expect(hidden).toEqual(new Set(['n2', 'n3']))
    expect(counts.get('n1')).toBe(3)
  })

  it('leaves hand-written rows alone — somebody who typed it twice meant it twice', () => {
    const rows = [
      row('a', '2026-08-19T20:00:00.000Z', 'Wasser marsch', { kind: 'journal', icon: 'type' }),
      row('b', '2026-08-19T20:00:04.000Z', 'Wasser marsch', { kind: 'journal', icon: 'type' }),
    ]
    expect(repeatRuns(rows).hidden.size).toBe(0)
  })
})

// Reversed 31.08.: a wordless picture row reads «Foto» again. Blanking it left the Verlauf — and
// the printed Rapport, read by people who were not there — as a column of bare timestamps.
describe('rowText — a wordless photo row falls back to «Foto»', () => {
  const photoRow = (text: string, photoUrls?: string[]) =>
    ({ id: 'e1', t: '10:00', icon: 'photo', text, photoUrls }) as TimelineEvent

  it('labels a picture row that carries no caption of its own', () => {
    expect(rowText(photoRow('', ['/api/media/1']))).toBe('Foto')
  })

  it('keeps a caption somebody actually typed', () => {
    expect(rowText(photoRow('Fotos vom Dachstock', ['/api/media/1']))).toBe('Fotos vom Dachstock')
  })

  // rows written before 06.08. carry the word in the record; it must survive verbatim
  it('keeps the word on an older row that stored it', () => {
    expect(rowText(photoRow('Foto', ['/api/media/1']))).toBe('Foto')
  })

  // the one thing left saying a picture was meant, on a row whose upload never arrived
  it('leaves a row without any picture exactly as written', () => {
    expect(rowText(photoRow(''))).toBe('')
    expect(rowText(photoRow('Foto'))).toBe('Foto')
  })

  it('reads the old single-photo shape too', () => {
    expect(rowText({ id: 'e1', t: '10:00', icon: 'photo', text: '', photoUrl: '/api/media/1' } as TimelineEvent)).toBe('Foto')
  })
})
