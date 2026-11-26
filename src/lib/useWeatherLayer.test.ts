// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('./api', () => ({ apiGet: vi.fn() }))

import { apiGet } from './api'
import { useWeatherLayer } from './useWeatherLayer'
import { radarIsStale, type ApiWeatherLayer } from './weatherLayer'

const get = vi.mocked(apiGet)
const answer = (enabled: boolean) => ({ enabled, generated_at: '2026-10-08T17:20:00Z', radar: null })
const T0 = Date.parse('2026-10-08T17:20:00Z')
/** a fresh radar answer (a new object each call, as the network hands it), stale 10 min after T0 */
const radarAnswer = (): ApiWeatherLayer => ({
  enabled: true, generated_at: '2026-10-08T17:20:00Z',
  radar: {
    frames: [{ key: 'f1', time: '2026-10-08T17:20:00Z' }], coordinates: null, data_time: '2026-10-08T17:20:00Z',
    stale: false, stale_after_seconds: 600, legend: [], attribution: '', source_url: '',
    status: { last_attempt_at: null, last_success_at: null, last_error: null, last_error_at: null },
  },
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  get.mockReset()
})
afterEach(() => vi.useRealTimers())

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWeatherLayer', () => {
  it('asks for the radar, and keeps polling while enabled', async () => {
    get.mockResolvedValue(answer(true))
    const { result } = renderHook(() => useWeatherLayer(true))
    await flush()
    expect(get).toHaveBeenCalledWith('/api/weather/layer')
    expect(result.current.data?.enabled).toBe(true)
    await act(async () => { vi.advanceTimersByTime(2 * 60_000) })
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('stops for good once the deployment says the layer is off', async () => {
    get.mockResolvedValue(answer(false))
    renderHook(() => useWeatherLayer(true))
    await flush()
    await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer through a failed poll (offline never empties the layer)', async () => {
    get.mockResolvedValueOnce(answer(true)).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useWeatherLayer(true))
    await flush()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.data?.enabled).toBe(true)
  })

  it('does not ask again when the Karte is left and re-entered within half a minute', async () => {
    get.mockResolvedValue(answer(true))
    const { rerender } = renderHook(({ on }) => useWeatherLayer(on), { initialProps: { on: true } })
    await flush()
    rerender({ on: false })
    rerender({ on: true })
    await flush()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('fetches nothing while inactive (another surface, the replay)', async () => {
    renderHook(() => useWeatherLayer(false))
    await flush()
    expect(get).not.toHaveBeenCalled()
  })

  // perf sweep 26.11.2026: an unchanged answer every minute plus a 30 s clock rendered the whole
  // workspace three to four times a minute, for a `now` that only the radar's staleness reads
  it('an unchanged answer and the passing clock cost no render until the radar goes stale', async () => {
    vi.setSystemTime(T0 + 60_000)
    get.mockImplementation(async () => radarAnswer())
    let renders = 0
    const { result } = renderHook(() => { renders++; return useWeatherLayer(true) })
    await flush()
    expect(result.current.data?.radar?.data_time).toBe('2026-10-08T17:20:00Z')
    const before = renders
    const minute = async () => {
      for (let i = 0; i < 2; i++) {
        await act(async () => { vi.advanceTimersByTime(30_000) })
        await flush()
      }
    }
    await minute()
    await minute()
    expect(get).toHaveBeenCalledTimes(3)
    expect(renders - before).toBe(0)
    // T0 + 3 min → + 11 min: the transition to «veraltet» still lands, within one 30 s clock tick
    for (let m = 0; m < 8; m++) await minute()
    const { data, now } = result.current
    expect(data?.radar && radarIsStale(data.radar, now)).toBe(true)
    expect(renders - before).toBe(1)
  })
})

