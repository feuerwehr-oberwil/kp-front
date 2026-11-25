// Hunt 24.11.2026, records-rapport F4–F6, F9: the printed Rapport says what the app says – folded
// corrections, the Nachtrag mark, the two 02:15 of the autumn clock change, a roster frozen by
// its signature. The station's wall clock is Zurich; the suite pins it for this file.
import { afterAll, describe, expect, it } from 'vitest'
import type { TimelineEvent } from '../types'
import { defaultReportOptions, formatDateTime, journalRows } from './report'
import { buildDirectReportPayload, type DirectReportArgs } from './reportPdfDirect'
import { signedRoster, type ReportSignature } from './reportSignature'
import { wallInstant } from './format'

const tz = process.env.TZ
process.env.TZ = 'Europe/Zurich'
afterAll(() => { process.env.TZ = tz })

const time = (minute: number) => `2026-11-24T08:${String(minute).padStart(2, '0')}:00.000Z`
const report = (events: TimelineEvent[]) => buildDirectReportPayload({
  incident: { id: 'local', title: 'Übung', started_at: time(0), is_exercise: true, is_archived: false } as DirectReportArgs['incident'],
  draft: { meta: {}, generatedAt: time(55), proof: { intact: null, checkedAt: time(55) }, options: { ...defaultReportOptions } },
  trupps: [], events, attendance: {}, plans: [],
}) as { journal: { text: string; textOriginal?: string; timeLabel: string }[] }

it('the QR-Erfassung prints a corrected row corrected and a withdrawn one not at all', () => {
  // CaptureApp hands the raw server rows over, patches included
  const { journal } = report([
    { id: 'a', t: '', at: time(1), kind: 'journal', icon: 'type', text: 'Gebäude geräumt' },
    { id: 'b', t: '', at: time(2), kind: 'journal', icon: 'type', text: 'Zutritt frei' },
    { id: 'c', t: '', at: time(3), icon: '', text: '', patchOf: 'a', textEdit: 'EG geräumt' },
    { id: 'd', t: '', at: time(4), icon: '', text: '', patchOf: 'b', retracted: true },
  ])
  expect(journal).toEqual([expect.objectContaining({ text: 'EG geräumt', textOriginal: 'Gebäude geräumt' })])
})

it('a repeat that reached the record after the close keeps its own row and Nachtrag mark', () => {
  const rows = journalRows([
    { id: 'a', t: '', at: '2026-11-24T08:01:00Z', kind: 'team', icon: 'radio', text: 'Trupp 1: Kontakt', subjectId: '1' },
    { id: 'b', t: '', at: '2026-11-24T08:02:10Z', kind: 'team', icon: 'radio', text: 'Trupp 1: Kontakt', subjectId: '1', receivedAfterClose: true },
  ], [], undefined, '2026-11-24T08:02:20Z')
  expect(rows.map((r) => [r.id, r.nachtrag])).toEqual([['a', false], ['b', true]])
  // …and a Nachtrag ends the in-time run: in time, late, in time again are three rows
  const three = journalRows([
    { id: 'a', t: '', at: '2026-11-24T08:01:00Z', kind: 'journal', icon: 'type', text: 'Pumpe läuft' },
    { id: 'b', t: '', at: '2026-11-24T08:01:30Z', kind: 'journal', icon: 'type', text: 'Pumpe läuft', receivedAfterClose: true },
    { id: 'c', t: '', at: '2026-11-24T08:02:00Z', kind: 'journal', icon: 'type', text: 'Pumpe läuft' },
  ], [], undefined, '2026-11-24T08:05:00Z')
  expect(three.map((r) => r.id)).toEqual(['a', 'b', 'c'])
})

describe('the autumn clock change', () => {
  const first = '2026-10-25T00:15:00.000Z' // 02:15 summer time
  const second = '2026-10-25T01:15:00.000Z' // 02:15 winter time

  it('prints the two 02:15 apart in the Journal, and leaves the signed times as they were', () => {
    // the Haupt-Rapport's times are signed: a suffix there would void every signature in that hour
    expect(formatDateTime(first)).toBe(formatDateTime(second))
    const { journal } = report([
      { id: 'a', t: '', at: first, kind: 'journal', icon: 'type', text: 'Kontakt' },
      { id: 'b', t: '', at: second, kind: 'journal', icon: 'type', text: 'Rückzug' },
    ])
    expect(journal[0].timeLabel).not.toBe(journal[1].timeLabel)
    expect(formatDateTime(time(5))).toBe('24.11.2026 09:05') // an ordinary hour stays plain
  })

  it('a wall time keeps the offset it was opened on; one the spring change skips has no instant', () => {
    const v = { y: 2026, mo: 10, d: 25, h: 2, mi: 15 }
    expect(wallInstant(v, new Date(second))?.toISOString()).toBe(second)
    expect(wallInstant(v, new Date(first))?.toISOString()).toBe(first)
    expect(wallInstant({ y: 2026, mo: 3, d: 29, h: 2, mi: 15 })).toBeNull()
    expect(wallInstant({ y: 2026, mo: 3, d: 29, h: 3, mi: 15 })?.toISOString()).toBe('2026-03-29T01:15:00.000Z')
  })
})

it('a closed Rapport prints the roster its signature froze, an open one today’s', () => {
  const signed = [{ id: 'p1', name: 'Muster Lea' }, { id: 'p2', name: 'Beispiel Nina' }]
  const sig = { id: 's', role: 'el', name: 'Muster Lea', at: time(50), scope: 'x', strokes: { w: 1, h: 1, d: [] }, roster: signed } satisfies ReportSignature
  const today = signed.slice(0, 1)
  expect(signedRoster({ el: sig }, true, today)).toEqual(signed)
  expect(signedRoster({ el: sig }, false, today)).toEqual(today)
  // a signature from before the roster was frozen: today's roster, as before
  expect(signedRoster({ el: { ...sig, roster: undefined } }, true, today)).toEqual(today)
  // …and when such a signature is the NEWEST, it decides – not an older one's snapshot
  const legacyKdt = { ...sig, id: 'k', role: 'kdt', at: time(52), roster: undefined } satisfies ReportSignature
  expect(signedRoster({ el: sig, kdt: legacyKdt }, true, today)).toEqual(today)
})
