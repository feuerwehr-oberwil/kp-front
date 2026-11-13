import { describe, expect, it } from 'vitest'
import { fahrtenText, freshWindShift, WIND_SHIFT_FRESH_MS } from './vehiclePresence'
import type { TimelineEvent } from '../types'

const NOW = Date.parse('2026-09-23T18:40:00Z')

describe('fahrtenText — the shuttle trips, on screen and paper', () => {
  it('counts the trips only where there was more than one', () => {
    expect(fahrtenText({ id: 'mtf', gps: { zone: 'away', fahrten: 3 } })).toBe('3 Fahrten')
    expect(fahrtenText({ id: 'tlf', gps: { zone: 'scene', fahrten: 1 } })).toBe('')
    expect(fahrtenText({ id: 'tlf' })).toBe('')
  })
})

describe('freshWindShift — the server row, once, while it is news', () => {
  const row = (id: string, at: string, text = 'Wind dreht: W → NO (286° → 66°) · Lüfter prüfen'): TimelineEvent =>
    ({ id, t: '', at, icon: 'wind', text }) as TimelineEvent

  it('shows the newest fresh shift, split into title and the thing to do', () => {
    const rows = [
      row('wxd-202609231820', '2026-09-23T18:20:00Z', 'Wind dreht: S → W (180° → 270°) · Lüfter prüfen'),
      row('wxd-202609231830', '2026-09-23T18:30:00Z'),
      row('t1', '2026-09-23T18:35:00Z', 'Lage erkundet'),
    ]
    expect(freshWindShift(rows, NOW, new Set())).toEqual({
      id: 'wxd-202609231830', title: 'Wind dreht: W → NO (286° → 66°)', sub: 'Lüfter prüfen',
    })
  })

  it('is timed from when the row ARRIVED, not from the reading it records', () => {
    // MeteoSwiss lag + the 10-min cadence: the reading is 40 min old when the row is written
    const late = { ...row('wxd-202609231800', '2026-09-23T18:00:00Z'), writtenAt: '2026-09-23T18:38:00Z' }
    expect(freshWindShift([late], NOW, new Set())?.id).toBe('wxd-202609231800')
    // …and the 30-min window runs from that arrival
    expect(freshWindShift([late], Date.parse('2026-09-23T18:38:00Z') + WIND_SHIFT_FRESH_MS + 1, new Set())).toBeNull()
  })

  it('stays down once waved away, and goes by itself once it is old', () => {
    const rows = [row('wxd-202609231830', '2026-09-23T18:30:00Z')]
    expect(freshWindShift(rows, NOW, new Set(['wxd-202609231830']))).toBeNull()
    expect(freshWindShift(rows, Date.parse('2026-09-23T18:30:00Z') + WIND_SHIFT_FRESH_MS + 1, new Set())).toBeNull()
  })
})
