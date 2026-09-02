import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteServerTime, resetServerClock, serverClockOffsetMs, serverNow } from './serverClock'

// The contact clock is `now − lastContactTime`, and both halves used to be device-local. A phone
// six seconds ahead of the PC therefore showed the same Trupp six seconds younger — constantly,
// on the one surface where a clock reading short is a safety failure. These lock the correction
// AND its two guarantees: it never moves a running clock backwards, and it is a no-op offline.

const iso = (ms: number) => new Date(ms).toISOString()

afterEach(() => { resetServerClock(); vi.useRealTimers() })

describe('serverClock', () => {
  it('is the plain device clock until a server answer has been seen', () => {
    vi.useFakeTimers().setSystemTime(1_000_000)
    expect(serverClockOffsetMs()).toBeNull()
    expect(serverNow()).toBe(1_000_000)
  })

  it('corrects a device that runs ahead — two devices land on the same instant', () => {
    // the phone's clock says 1_006_000 when the server's answer says 1_000_000 → 6 s ahead
    noteServerTime(iso(1_000_000), 1_006_000)
    vi.useFakeTimers().setSystemTime(1_006_000)
    expect(serverClockOffsetMs()).toBe(6_000)
    expect(serverNow()).toBe(1_000_000)
  })

  it('corrects a device that runs behind', () => {
    noteServerTime(iso(1_000_000), 995_000)
    vi.useFakeTimers().setSystemTime(995_000)
    expect(serverNow()).toBe(1_000_000)
  })

  it('keeps the least-latency sample, so a slow answer never shunts the clock backwards', () => {
    noteServerTime(iso(1_000_000), 1_006_000) // offset 6 s
    noteServerTime(iso(1_002_000), 1_010_000) // offset 8 s — 2 s of it was travel time
    expect(serverClockOffsetMs()).toBe(6_000)
    noteServerTime(iso(1_004_000), 1_009_500) // offset 5.5 s — a faster answer wins
    expect(serverClockOffsetMs()).toBe(5_500)
  })

  it('re-syncs when the device clock itself is corrected (a jump far past the jitter band)', () => {
    noteServerTime(iso(1_000_000), 1_006_000)
    noteServerTime(iso(1_010_000), 1_130_000) // the OS moved the clock 2 min ahead
    expect(serverClockOffsetMs()).toBe(120_000)
  })

  it('ignores a missing or unparseable header — no information beats wrong information', () => {
    noteServerTime(null)
    noteServerTime('')
    noteServerTime('not-a-date')
    expect(serverClockOffsetMs()).toBeNull()
  })
})
