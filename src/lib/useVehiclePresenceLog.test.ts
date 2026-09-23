// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity, LngLat, TimelineEvent } from '../types'
import { lastPresence, presenceRowId, useVehiclePresenceLog } from './useVehiclePresenceLog'

const CENTER: LngLat = [7.53, 47.41]
// ~0.001° of latitude ≈ 111 m, which is the unit these rings are worth testing in
const north = (m: number): LngLat => [CENTER[0], CENTER[1] + m / 111_320]

const tlf = (coord: LngLat): Entity => ({
  id: 'tlf', kind: 'vehicle', label: 'TLF', coord, live: true,
} as Entity)

afterEach(() => vi.useRealTimers())
beforeEach(() => vi.useFakeTimers())

/** drive the hook through a sequence of positions, settling the clock between each */
function run(steps: LngLat[], opts: { enabled?: boolean; waitMs?: number } = {}) {
  const log = vi.fn()
  const { rerender } = renderHook(
    ({ v }: { v: Entity[] }) => useVehiclePresenceLog({
      vehicles: v, center: CENTER, enabled: opts.enabled ?? true, log,
    }),
    { initialProps: { v: [tlf(steps[0])] } },
  )
  for (const coord of steps.slice(1)) {
    // each reading arrives, then the settle window passes and the NEXT poll writes the line
    rerender({ v: [tlf(coord)] })
    vi.advanceTimersByTime(opts.waitMs ?? 120_000)
    rerender({ v: [tlf(coord)] })
  }
  return log
}

describe('useVehiclePresenceLog', () => {
  it('says nothing about the first sighting — that time would be meaningless', () => {
    // the tablet may have been unlocked an hour into the Einsatz
    const log = run([north(20)])
    expect(log).not.toHaveBeenCalled()
  })

  it('records the departure, which is the question nobody can answer later', () => {
    const log = run([north(20), north(600)])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('TLF hat den Einsatzort verlassen')
  })

  it('records an arrival the same way', () => {
    const log = run([north(900), north(30)])
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('TLF vor Ort')
  })

  it('⚠️ does not flap on GPS scatter — the two rings are what stop that', () => {
    // a fix wandering between 140 m and 200 m never leaves the band between the rings, and
    // an append-only journal cannot take a wrong line back
    const log = run([north(20), north(200), north(140), north(210), north(160)])
    expect(log).not.toHaveBeenCalled()
  })

  it('ignores a vehicle that only clips the ring while manoeuvring', () => {
    // out past the far ring and straight back, faster than the settle window
    const log = run([north(20), north(600), north(20)], { waitMs: 30_000 })
    expect(log).not.toHaveBeenCalled()
  })

  it('treats a vehicle dropping out of the feed as silence, not as a departure', () => {
    const log = vi.fn()
    const { rerender } = renderHook(
      ({ v }: { v: Entity[] }) => useVehiclePresenceLog({ vehicles: v, center: CENTER, enabled: true, log }),
      { initialProps: { v: [tlf(north(20))] } },
    )
    rerender({ v: [] })
    vi.advanceTimersByTime(300_000)
    rerender({ v: [] })
    expect(log).not.toHaveBeenCalled()
  })

  it('writes nothing at all for a viewer or during replay', () => {
    const log = run([north(20), north(600)], { enabled: false })
    expect(log).not.toHaveBeenCalled()
  })

  // ⚠️ 03.09.: the TLF and the PIO each printed «hat den Einsatzort verlassen» three times, at
  // the identical second, with no arrival between any of them. Both were parked in the band
  // between the rings, where a vehicle with no history used to be baselined as «vor Ort» — so
  // every re-baseline re-armed a departure that had already been recorded.
  it('⚠️ a vehicle first seen BETWEEN the rings is not booked «vor Ort»', () => {
    // parked ~200 m out, seen for the first time there — the app knows nothing about whether it
    // ever was at the Einsatzort, and the drift past the far ring is therefore no departure.
    const log = run([north(200), north(600)])
    expect(log).not.toHaveBeenCalled()
  })

  it('⚠️ does not report a SECOND departure after a feed gap', () => {
    const log = vi.fn()
    const props = { v: [tlf(north(20))] }
    const { rerender } = renderHook(
      ({ v }: { v: Entity[] }) => useVehiclePresenceLog({ vehicles: v, center: CENTER, enabled: true, log }),
      { initialProps: props },
    )
    const settle = (coord: LngLat) => {
      rerender({ v: [tlf(coord)] })
      vi.advanceTimersByTime(120_000)
      rerender({ v: [tlf(coord)] })
    }
    settle(north(600))                                   // it leaves — one line, correctly
    rerender({ v: [] }); vi.advanceTimersByTime(120_000) // the feed goes quiet
    settle(north(200))                                   // …and comes back mid-band
    settle(north(600))                                   // …and drifts out again
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('TLF hat den Einsatzort verlassen')
  })

  it('⚠️ a feed gap does not swallow the arrival that follows it', () => {
    const log = vi.fn()
    const { rerender } = renderHook(
      ({ v }: { v: Entity[] }) => useVehiclePresenceLog({ vehicles: v, center: CENTER, enabled: true, log }),
      { initialProps: { v: [tlf(north(900))] } },
    )
    rerender({ v: [] })                 // Traccar restarts / the tablet loses the network
    vi.advanceTimersByTime(300_000)
    for (const coord of [north(30), north(30)]) {
      rerender({ v: [tlf(coord)] })
      vi.advanceTimersByTime(120_000)
      rerender({ v: [tlf(coord)] })
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][1]).toBe('TLF vor Ort')
  })
})

// ⚠️ 23.09.2026 (post-mortem D5): «MAWA hat den Einsatzort verlassen» three times — 18:38:53,
// :58 and 18:39:04, one per tablet on the same login — and a device that woke later wrote TLF
// and PIO leaving a SECOND time, ten minutes after the first. The row id is now the vehicle's
// transition number in the shared Verlauf, so every device mints the same one.
describe('useVehiclePresenceLog · one row per transition across devices', () => {
  /** the server's Verlauf: a known id is skipped (backend · journal.append_rows) */
  const server = () => {
    const rows = new Map<string, TimelineEvent>()
    return {
      rows,
      view: () => [...rows.values()],
      logFor: (written: string[]) => vi.fn((_icon: string, text: string, _k?: unknown, _s?: unknown, _e?: unknown, opts?: { rowId?: string }) => {
        const id = opts?.rowId ?? `e${Date.now()}-${written.length}`
        written.push(id)
        if (!rows.has(id)) rows.set(id, { id, t: '', at: new Date().toISOString(), icon: 'truck', text } as TimelineEvent)
      }),
    }
  }
  type Server = ReturnType<typeof server>
  const device = (srv: Server, written: string[], start: LngLat, rows: () => TimelineEvent[] = srv.view) => {
    const log = srv.logFor(written)
    const hook = renderHook(
      ({ v, r }: { v: Entity[]; r: TimelineEvent[] }) => useVehiclePresenceLog({ vehicles: v, center: CENTER, enabled: true, log, rows: r }),
      { initialProps: { v: [tlf(start)], r: rows() } },
    )
    return { see: (coord: LngLat) => hook.rerender({ v: [tlf(coord)], r: rows() }) }
  }

  it('three devices settling on the same departure before any row synced write ONE id', () => {
    const srv = server()
    const written: string[] = []
    // each device reads only its own (empty) view — nothing has synced between them yet
    const devices = [0, 1, 2].map(() => device(srv, written, north(20), () => []))
    for (const d of devices) d.see(north(600))
    vi.advanceTimersByTime(95_000)
    for (const d of devices) { d.see(north(600)); vi.advanceTimersByTime(5_000) }
    expect(written).toHaveLength(3)
    expect(new Set(written)).toEqual(new Set(['vp-1-away-tlf']))
    expect(srv.rows.size).toBe(1)
  })

  it('a device whose settle finishes after the row arrived writes nothing — even ten minutes later', () => {
    const srv = server()
    const written: string[] = []
    const a = device(srv, written, north(20))
    const b = device(srv, written, north(20))
    a.see(north(600)); vi.advanceTimersByTime(95_000); a.see(north(600))
    expect(srv.rows.size).toBe(1)
    vi.advanceTimersByTime(600_000) // b was asleep
    b.see(north(600)); vi.advanceTimersByTime(95_000); b.see(north(600))
    expect(written).toEqual(['vp-1-away-tlf'])
  })

  it('a vehicle that genuinely shuttles gets a row per trip, numbered', () => {
    const srv = server()
    const written: string[] = []
    const a = device(srv, written, north(20))
    const b = device(srv, written, north(20))
    for (const coord of [north(900), north(30), north(900), north(30)]) {
      for (const d of [a, b]) d.see(coord)
      vi.advanceTimersByTime(95_000)
      for (const d of [a, b]) d.see(coord)
      vi.advanceTimersByTime(60_000)
    }
    expect([...srv.rows.keys()]).toEqual(['vp-1-away-tlf', 'vp-2-scene-tlf', 'vp-3-away-tlf', 'vp-4-scene-tlf'])
    expect(written).toHaveLength(4) // the second device found every one already written
  })

  it('a departure after an arrival nobody recorded is still a NEW row, not adopted', () => {
    const srv = server()
    const written: string[] = []
    const a = device(srv, written, north(20))
    a.see(north(900)); vi.advanceTimersByTime(95_000); a.see(north(900)) // vp-1 away
    // a second device opens later with the vehicle back at the Einsatzort (its return unrecorded)
    vi.advanceTimersByTime(300_000)
    const b = device(srv, written, north(20))
    vi.advanceTimersByTime(60_000); b.see(north(20))
    b.see(north(900)); vi.advanceTimersByTime(95_000); b.see(north(900))
    expect([...srv.rows.keys()]).toEqual(['vp-1-away-tlf', 'vp-2-away-tlf'])
  })

  it('lastPresence reads the chain back off the ids, ignoring other vehicles and legacy rows', () => {
    const rows = [
      { id: 'e1790188733349-39', at: '2026-09-23T18:38:53Z' },
      { id: presenceRowId('gps-8', 1, 'away'), at: '2026-09-23T18:38:53Z' },
      { id: presenceRowId('gps-8', 2, 'scene'), at: '2026-09-23T18:51:00Z' },
      { id: presenceRowId('gps-3', 7, 'away'), at: '2026-09-23T20:30:01Z' },
    ] as TimelineEvent[]
    expect(lastPresence(rows, 'gps-8')).toEqual({ n: 2, zone: 'scene', atMs: Date.parse('2026-09-23T18:51:00Z') })
    expect(lastPresence(rows, 'gps-4')).toBeNull()
  })
})
