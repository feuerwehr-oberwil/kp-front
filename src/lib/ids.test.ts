import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPlayerRowId, newId, newRowId } from './ids'
import { simulatedDevice } from './devices.test-utils'

afterEach(() => { vi.useRealTimers() })

describe('newId', () => {
  // The whole reason this exists: `d${Date.now()}` gave two drawings finished inside one
  // millisecond the SAME id, and the workspace merge then treated them as one record.
  it('mints distinct ids within one millisecond', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'))
    const ids = Array.from({ length: 500 }, () => newId('d'))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the prefix, the timestamp and a URL/storage-safe charset', () => {
    vi.useFakeTimers()
    const at = new Date('2026-09-02T10:00:00Z')
    vi.setSystemTime(at)
    const id = newId('sh')
    expect(id.startsWith(`sh${at.getTime()}`)).toBe(true)
    expect(id).toMatch(/^[a-z0-9-]+$/)
  })
})

// Post-mortem 23.09.2026: one editor login on three tablets. Each device's counters start at 0, so
// a counter alone keeps ONE device's ids apart and never two devices' — the random tail must.
describe('ids across devices in one millisecond', () => {
  const AT = new Date('2026-09-23T19:04:05.123Z')
  const device = (seed: number) => simulatedDevice(seed, () => import('./ids'))

  it('two devices appending Verlauf rows at the same instant mint distinct ids', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(AT)
    const a = await device(1)
    const b = await device(2)
    const mint = (d: typeof a) => d.run(() => [d.mod.newRowId(), d.mod.newRowId('j'), d.mod.newRowId('v'), d.mod.newRowId('p')])
    const fromA = mint(a)
    const fromB = mint(b)
    expect(new Set([...fromA, ...fromB]).size).toBe(8)
    // still the house shape: `e<ms>-…`, the minting instant first
    for (const id of [...fromA, ...fromB]) expect(id.startsWith(`e${AT.getTime()}-`)).toBe(true)
    expect(fromA[1]).toMatch(/-j$/)
    expect(fromA[2]).toMatch(/-v$/)
    expect(fromA[3]).toMatch(/-p$/)
  })

  it('the recipe it replaces collides on exactly that', () => {
    // `e${Date.now()}-${rowSeq++}`, each device's rowSeq at 0 — the shape prod held 149 of
    const legacy = () => { let rowSeq = 0; return () => `e${AT.getTime()}-${rowSeq++}` }
    expect(legacy()()).toBe(legacy()())
  })

  it('load: 3 devices × 1000 rows in one frozen millisecond → 3000 distinct ids', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(AT)
    const devices = [await device(11), await device(22), await device(33)]
    const ids: string[] = []
    // interleaved, the way three tablets write: every device's counter at the same step
    for (let i = 0; i < 1000; i++) for (const d of devices) ids.push(d.run(() => d.mod.newRowId()))
    expect(ids).toHaveLength(3000)
    expect(new Set(ids).size).toBe(3000)
    expect(ids.every((id) => id.startsWith(`e${AT.getTime()}-`))).toBe(true)
  })
})

describe('isPlayerRowId — the audio player retracts only its own rows', () => {
  it('knows the legacy shape `e<ms>-p<n>`', () => {
    expect(isPlayerRowId('e1758038400123-p0')).toBe(true)
    expect(isPlayerRowId('e1758038400123-p12')).toBe(true)
    expect(isPlayerRowId('e1758038400123-p999')).toBe(true)
  })

  it("knows the new shape `newRowId('p')`", () => {
    expect(isPlayerRowId('e1758038400123-0kf9a-p')).toBe(true)
    for (let i = 0; i < 200; i++) expect(isPlayerRowId(newRowId('p'))).toBe(true)
  })

  it('never takes a log line for one — legacy or new', () => {
    for (const id of ['e1758038400123-3', 'e1758038400123-j', 'e1758038400123-v', 'qr1758038400123-0', 'tp1758038400123-0-e1']) {
      expect(isPlayerRowId(id)).toBe(false)
    }
    // ⚠️ an ordinary newId('e') whose counter reads `p1` and whose random tail is all digits
    expect(isPlayerRowId('e1758038400123-p1234')).toBe(false)
    expect(isPlayerRowId(newRowId('j'))).toBe(false)
    expect(isPlayerRowId(newRowId('v'))).toBe(false)
  })

  it('no ordinary row matches, whatever the counter reads, even with an all-digit random tail', () => {
    // a random whose base-36 digits start «123» — the tail that makes `…-p<d>123` look legacy
    const spy = vi.spyOn(Math, 'random').mockReturnValue((1 * 36 * 36 + 2 * 36 + 3) / 36 ** 3 + 1e-9)
    try {
      expect(newRowId()).toMatch(/123$/)
      // every counter value, twice round
      for (let i = 0; i < 2 * 1296; i++) expect(isPlayerRowId(newRowId())).toBe(false)
    } finally { spy.mockRestore() }
  })
})
