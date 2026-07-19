import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '../types'
import {
  audioWindowOf,
  clockTicks,
  currentMarkerIndex,
  formatElapsed,
  markerTone,
  markersInWindow,
  wallClockAt,
} from './audioPlayer'

const row = (over: Partial<TimelineEvent>): TimelineEvent =>
  ({ id: 'e1', t: '14:32', icon: 'type', text: 'x', ...over }) as TimelineEvent

const audioRow = row({
  id: 'a1',
  kind: 'audio',
  audioUrl: '/api/media/m1',
  audioMeta: { source: 'imported', startedAt: '2026-07-16T14:32:00', durationSec: 8100 },
})

describe('audioWindowOf', () => {
  it('uses audioMeta when present', () => {
    const w = audioWindowOf(audioRow)!
    expect(w.startMs).toBe(Date.parse('2026-07-16T14:32:00'))
    expect(w.durationSec).toBe(8100)
  })
  it('falls back to the row time for legacy clips (duration unknown)', () => {
    const w = audioWindowOf(row({ at: '2026-07-16T15:00:00', audioUrl: '/api/media/m2' }))!
    expect(w.startMs).toBe(Date.parse('2026-07-16T15:00:00'))
    expect(w.durationSec).toBe(0)
  })
  it('returns null without any usable time', () => {
    expect(audioWindowOf(row({ audioMeta: { source: 'imported', startedAt: 'kaputt' } }))).toBeNull()
  })
})

describe('markersInWindow', () => {
  const win = audioWindowOf(audioRow)!
  const events: TimelineEvent[] = [
    audioRow, // the carrier itself — excluded
    row({ id: 'e2', at: '2026-07-16T14:35:00', kind: 'journal' }),
    row({ id: 'e3', at: '2026-07-16T15:02:00', kind: 'reminder' }),
    row({ id: 'e4', at: '2026-07-16T14:20:00', kind: 'journal' }),         // before window
    row({ id: 'e5', at: '2026-07-16T17:30:00', kind: 'journal' }),         // after window
    row({ id: 'e6', at: '2026-07-16T15:00:00', patchOf: 'a1' }),           // patch — excluded
    row({ id: 'e7', at: '2026-07-16T16:47:00', kind: 'symbol' }),          // exactly at end
  ]
  it('keeps in-window rows, sorted by offset, excluding self and patches', () => {
    const m = markersInWindow(events, win, 'a1')
    expect(m.map((x) => x.row.id)).toEqual(['e2', 'e3', 'e7'])
    expect(m[0].offsetSec).toBe(180)
    expect(m[1].tone).toBe('reminder')
    expect(m[2].tone).toBe('system')
  })
  it('yields nothing while the duration is unknown', () => {
    expect(markersInWindow(events, { startMs: win.startMs, durationSec: 0 }, 'a1')).toEqual([])
  })
})

describe('currentMarkerIndex', () => {
  const m = markersInWindow(
    [row({ id: 'e2', at: '2026-07-16T14:35:00', kind: 'journal' }),
     row({ id: 'e3', at: '2026-07-16T15:02:00', kind: 'journal' })],
    audioWindowOf(audioRow)!, 'a1')
  it('tracks the most recently passed marker', () => {
    expect(currentMarkerIndex(m, 0)).toBe(-1)
    expect(currentMarkerIndex(m, 180)).toBe(0)
    expect(currentMarkerIndex(m, 5000)).toBe(1)
  })
})

describe('markerTone', () => {
  it('groups kinds into entry / reminder / system', () => {
    expect(markerTone('journal')).toBe('entry')
    expect(markerTone('photo')).toBe('entry')
    expect(markerTone('reminder')).toBe('reminder')
    expect(markerTone('symbol')).toBe('system')
    expect(markerTone(undefined)).toBe('system')
  })
})

describe('formatElapsed / wallClockAt', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatElapsed(47)).toBe('0:47')
    expect(formatElapsed(754)).toBe('12:34')
    expect(formatElapsed(8103)).toBe('2:15:03')
  })
  it('maps offsets to incident wall-clock', () => {
    const win = audioWindowOf(audioRow)!
    expect(wallClockAt(win, 0)).toBe('14:32')
    expect(wallClockAt(win, 42 * 60 + 12)).toBe('15:14')
  })
})

describe('clockTicks', () => {
  it('picks a step giving 3–7 round-time ticks for a 2¼ h recording', () => {
    const ticks = clockTicks(audioWindowOf(audioRow)!)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(7)
    expect(ticks[0].label).toBe('15:00') // first round half-hour inside the window
    expect(ticks.every((t) => t.p > 0 && t.p < 1)).toBe(true)
  })
  it('short clip gets 5-minute ticks; unknown duration gets none', () => {
    const win = { startMs: Date.parse('2026-07-16T14:32:00'), durationSec: 1500 }
    expect(clockTicks(win)[0].label).toBe('14:35')
    expect(clockTicks({ ...win, durationSec: 0 })).toEqual([])
  })
})
