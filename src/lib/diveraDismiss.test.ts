// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dismissAlarm, hiddenAlarms, loadDismissedAlarms, shownAlarms, undismissAlarm } from './diveraDismiss'
import type { DiveraAlarm } from './incidents'

const alarm = { divera_id: 1, title: 'Brandmeldeanlage', address: 'Bachweg 1, Musterdorf', received_at: '' } as DiveraAlarm

// Sweep 09.11.2026, UX.6: «Neuer Einsatz» waited for an EMPTY pool, but the pool keeps every
// untaken alarm for ever – App gates on what this returns instead.
describe('shownAlarms', () => {
  const now = Date.parse('2026-11-09T03:00:00Z')
  const at = (id: number, minutesAgo: number) =>
    ({ ...alarm, divera_id: id, received_at: new Date(now - minutesAgo * 60_000).toISOString() })

  it('leaves out what is hidden on this device and what is older than 3 h', () => {
    const pool = [at(1, 5), at(2, 10), at(3, 181)]
    expect(shownAlarms(pool, new Set([2]), now).map((a) => a.divera_id)).toEqual([1])
  })

  it('is empty for a pool of only stale and hidden alarms', () => {
    expect(shownAlarms([at(2, 10), at(3, 600)], new Set([2]), now)).toEqual([])
  })
})

// Rare-user round M3 = C (17.11.2026): ✕ folds the row to a strip with «Zeigen», not gone for good.
describe('hiddenAlarms + undismissAlarm', () => {
  const now = Date.parse('2026-11-17T03:00:00Z')
  const at = (id: number, minutesAgo: number) =>
    ({ ...alarm, divera_id: id, received_at: new Date(now - minutesAgo * 60_000).toISOString() })

  it('a hidden alarm stands as a strip inside the 3-h window only', () => {
    const pool = [at(1, 5), at(2, 10), at(3, 181)]
    expect(hiddenAlarms(pool, new Set([2, 3]), now).map((a) => a.divera_id)).toEqual([2])
  })

  it('«Zeigen» takes the alarm out of the hidden set, on this device, across a reload', () => {
    localStorage.clear()
    dismissAlarm(7); dismissAlarm(8)
    expect([...undismissAlarm(7)]).toEqual([8])
    expect([...loadDismissedAlarms()]).toEqual([8])
  })
})
