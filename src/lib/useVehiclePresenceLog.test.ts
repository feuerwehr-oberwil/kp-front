// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity, LngLat } from '../types'
import { useVehiclePresenceLog } from './useVehiclePresenceLog'

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
})
