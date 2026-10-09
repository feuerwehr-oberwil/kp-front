// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('./api', () => ({ apiGet: vi.fn() }))

import { apiGet } from './api'
import { useWeatherLayer } from './useWeatherLayer'

const get = vi.mocked(apiGet)
const CENTER: [number, number] = [7.556, 47.514]
const answer = (enabled: boolean) => ({ enabled, point: enabled, generated_at: '2026-10-08T17:20:00Z', radar: null, warnings: null })

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
  it('asks for the Einsatz point, and keeps polling while enabled', async () => {
    get.mockResolvedValue(answer(true))
    const { result } = renderHook(() => useWeatherLayer(CENTER, true))
    await flush()
    expect(get).toHaveBeenCalledWith('/api/weather/layer?lat=47.514&lng=7.556')
    expect(result.current.data?.enabled).toBe(true)
    await act(async () => { vi.advanceTimersByTime(2 * 60_000) })
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('stops for good once the deployment says the layer is off', async () => {
    get.mockResolvedValue(answer(false))
    renderHook(() => useWeatherLayer(CENTER, true))
    await flush()
    await act(async () => { vi.advanceTimersByTime(5 * 60_000) })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer through a failed poll (offline never empties the layer)', async () => {
    get.mockResolvedValueOnce(answer(true)).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useWeatherLayer(CENTER, true))
    await flush()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(get).toHaveBeenCalledTimes(2)
    expect(result.current.data?.enabled).toBe(true)
  })

  it('does not ask again when the Karte is left and re-entered within half a minute', async () => {
    get.mockResolvedValue(answer(true))
    const { rerender } = renderHook(({ on }) => useWeatherLayer(CENTER, on), { initialProps: { on: true } })
    await flush()
    rerender({ on: false })
    rerender({ on: true })
    await flush()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('fetches nothing while inactive (another surface, the replay)', async () => {
    renderHook(() => useWeatherLayer(CENTER, false))
    await flush()
    expect(get).not.toHaveBeenCalled()
  })
})
