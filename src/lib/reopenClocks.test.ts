import { describe, expect, it } from 'vitest'
import { clockRestartRowId, clocksAfterReopen, latestLifecycle } from './reopenClocks'
import type { TimelineEvent, Trupp } from '../types'

// After «Wieder öffnen», a crew still inside counted the whole closed interval as time without
// contact and rang «Überfällig» the instant the Einsatz ran again (staging r3, F4). Its clock
// restarts at the REOPEN — the server's boundary row, the same on every device.

const row = (id: string, at: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ id, t: '', at, icon: '', text: '', ...over })
const trupp = (id: string, over: Partial<Trupp> = {}): Trupp => ({
  id, name: `Tst ${id}`, status: 'aktiv', entryPressureBar: 300,
  entryTime: '2026-09-25T12:00:00Z', lastContactTime: '2026-09-25T12:20:00Z', ...over,
} as Trupp)

describe('latestLifecycle', () => {
  it('finds the newest boundary by its field — and by the words on rows written before it', () => {
    const rows = [
      row('sys1', '2026-09-25T12:45:00Z', { lifecycle: 'closed', text: 'Einsatz abgeschlossen' }),
      row('r1', '2026-09-25T12:50:00Z', { text: 'Meldung' }),
      row('sys2', '2026-09-25T13:40:00Z', { lifecycle: 'reopened', text: 'Einsatz wiedereröffnet (Nachtrag)' }),
    ]
    expect(latestLifecycle(rows)).toEqual({ kind: 'reopened', id: 'sys2', at: '2026-09-25T13:40:00Z' })
    expect(latestLifecycle([...rows].reverse())?.id).toBe('sys2') // order in does not matter
    const legacy = [row('sysA', '2026-09-25T12:45:00Z', { text: 'Einsatz abgeschlossen' })]
    expect(latestLifecycle(legacy)).toEqual({ kind: 'closed', id: 'sysA', at: '2026-09-25T12:45:00Z' })
    // a hand-typed row with the same words is not a boundary
    expect(latestLifecycle([row('r9', '2026-09-25T12:45:00Z', { text: 'Einsatz abgeschlossen' })])).toBeNull()
    expect(latestLifecycle([])).toBeNull()
  })
})

describe('clocksAfterReopen', () => {
  const reopen = { kind: 'reopened' as const, id: 'sys2', at: '2026-09-25T13:40:00Z' }

  it('restarts the contact clock of every crew still inside at the reopen', () => {
    const out = clocksAfterReopen([trupp('a'), trupp('b')], reopen)
    expect(out.map((t) => t.lastContactTime)).toEqual([reopen.at, reopen.at])
  })

  it('leaves a crew outside, a removed one, and a Kontakt given since the reopen alone', () => {
    const outside = trupp('out', { status: 'raus', exitTime: '2026-09-25T12:40:00Z' })
    const removed = trupp('rm', { removedAt: '2026-09-25T12:41:00Z' })
    const since = trupp('new', { lastContactTime: '2026-09-25T13:45:00Z' })
    const inside = trupp('in')
    const out = clocksAfterReopen([outside, removed, since, inside], reopen)
    expect(out[0]).toBe(outside)
    expect(out[1]).toBe(removed)
    expect(out[2]).toBe(since)
    expect(out[3].lastContactTime).toBe(reopen.at)
  })

  it('is idempotent — the same array when nothing moves (a machine writer must be)', () => {
    const once = clocksAfterReopen([trupp('a')], reopen)
    expect(clocksAfterReopen(once, reopen)).toBe(once)
    const list = [trupp('a')]
    expect(clocksAfterReopen(list, null)).toBe(list)
    expect(clocksAfterReopen(list, { ...reopen, kind: 'closed' })).toBe(list)
  })

  it('derives ONE row id per reopen and crew — the same on every device', () => {
    expect(clockRestartRowId('sys2', 'tr-1')).toBe('azro-sys2-tr-1')
  })
})
