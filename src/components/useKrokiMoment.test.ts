// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { loadReplay, stateAt, vehiclesAt, type ReplayBundle } from '../lib/replay'
import { toast } from '../lib/ui'
import type { Entity, TimelineEvent } from '../types'
import { initialKrokiAt, useKrokiMoment } from './useKrokiMoment'

vi.mock('../lib/replay', async (orig) => ({
  ...(await orig<typeof import('../lib/replay')>()),
  loadReplay: vi.fn(),
  stateAt: vi.fn(),
  vehiclesAt: vi.fn(() => []),
}))
vi.mock('../lib/ui', () => ({ toast: vi.fn() }))

const T0 = Date.parse('2026-10-24T20:00:00Z')
const AT = T0 + 30 * 60_000
const bundle = { events: [{ occurred_at: '2026-10-24T20:10:00Z', op_type: 'status.change' }], samples: [] } as unknown as ReplayBundle
const rettung = { id: 'e1', kind: 'symbol', coord: [7.5, 47.5] } as unknown as Entity
const NO_EVENTS: TimelineEvent[] = []

const hook = (over: Partial<Parameters<typeof useKrokiMoment>[0]> = {}) => renderHook(
  (p: Parameters<typeof useKrokiMoment>[0]) => useKrokiMoment(p),
  { initialProps: { incidentId: 'inc-1', startedAt: '2026-10-24T20:00:00Z', initialAt: null, shown: false, events: NO_EVENTS, ...over } },
)

beforeEach(() => {
  vi.mocked(loadReplay).mockResolvedValue(bundle)
  vi.mocked(stateAt).mockResolvedValue({ entities: [rettung], drawings: [] } as unknown as Awaited<ReturnType<typeof stateAt>>)
})
afterEach(() => vi.clearAllMocks())

describe('initialKrokiAt', () => {
  it('the Stand kept across the hop wins — «live» included — over the last print', () => {
    expect(initialKrokiAt({ krokiAt: AT }, '2026-10-24T21:00:00Z')).toBe(AT)
    expect(initialKrokiAt({ krokiAt: null }, '2026-10-24T21:00:00Z')).toBeNull()
  })
  it('a fresh open starts on the last print, and on live when there is none or it is garbage', () => {
    expect(initialKrokiAt(null, '2026-10-24T20:30:00Z')).toBe(AT)
    expect(initialKrokiAt(null, undefined)).toBeNull()
    expect(initialKrokiAt(null, 'nonsense')).toBeNull()
  })
})

describe('useKrokiMoment', () => {
  it('live by default: nothing is reconstructed and nothing is loaded', () => {
    const { result } = hook()
    expect(result.current).toMatchObject({ at: null, pastScene: null, busy: false, printedAt: null })
    expect(loadReplay).not.toHaveBeenCalled()
  })

  it('a picked instant reconstructs the Lage from the replay, and only then is stamped for print', async () => {
    const { result } = hook()
    act(() => result.current.setAt(AT))
    // in flight: the live Lage still prints, so no «Stand» caption may claim otherwise
    expect(result.current.busy).toBe(true)
    expect(result.current.printedAt).toBeNull()
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.pastScene?.entities).toEqual([rettung])
    expect(result.current.printedAt).toBe(new Date(AT).toISOString())
    expect(loadReplay).toHaveBeenCalledWith('inc-1', T0, expect.any(Number))
    expect(stateAt).toHaveBeenCalledWith(bundle, AT)
  })

  it('draws the recorded vehicles into the past Lage', async () => {
    vi.mocked(vehiclesAt).mockReturnValue([{ deviceId: 7, coord: [7.51, 47.51], course: 90 }] as unknown as ReturnType<typeof vehiclesAt>)
    const { result } = hook({ initialAt: AT })
    await waitFor(() => expect(result.current.pastScene).not.toBeNull())
    expect(result.current.pastScene?.entities.map((e) => e.id)).toEqual(['e1', 'replay-veh-7'])
  })

  it('a reconstruction that fails says so and falls back to live — no caption', async () => {
    vi.mocked(stateAt).mockRejectedValue(new Error('no snapshot'))
    const { result } = hook({ initialAt: AT })
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.pastScene).toBeNull()
    expect(result.current.printedAt).toBeNull()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('back to live drops the past Lage; the bundle is loaded once for every instant after', async () => {
    const { result } = hook({ initialAt: AT })
    await waitFor(() => expect(result.current.pastScene).not.toBeNull())
    act(() => result.current.setAt(AT + 60_000))
    await waitFor(() => expect(stateAt).toHaveBeenCalledTimes(2))
    act(() => result.current.setAt(null))
    expect(result.current.pastScene).toBeNull()
    expect(loadReplay).toHaveBeenCalledTimes(1)
  })

  // A Rapport reopened on a kept Stand with the Kroki on screen asks for the bundle from both
  // effects in the same tick – one download, not two in parallel.
  it('opening on a kept Stand with the panel shown loads the bundle once', async () => {
    const { result } = hook({ initialAt: AT, shown: true })
    await waitFor(() => expect(result.current.pastScene).not.toBeNull())
    await waitFor(() => expect(result.current.moments).toHaveLength(1))
    expect(loadReplay).toHaveBeenCalledTimes(1)
  })

  it('a bundle that failed to load is asked for again on the next instant', async () => {
    vi.mocked(loadReplay).mockRejectedValueOnce(new Error('offline'))
    const { result } = hook({ initialAt: AT })
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    act(() => result.current.setAt(AT + 60_000))
    await waitFor(() => expect(result.current.pastScene).not.toBeNull())
    expect(loadReplay).toHaveBeenCalledTimes(2)
  })

  it('the tick marks load when the panel is shown, and the Verlauf rows join them as they arrive', async () => {
    const { result, rerender } = hook()
    expect(result.current.moments).toEqual([])
    rerender({ incidentId: 'inc-1', startedAt: '2026-10-24T20:00:00Z', initialAt: null, shown: true, events: NO_EVENTS })
    await waitFor(() => expect(result.current.moments).toEqual([Date.parse('2026-10-24T20:10:00Z')]))
    const row = { id: 'j1', at: '2026-10-24T20:20:00Z', text: 'Rettung ab' } as unknown as TimelineEvent
    rerender({ incidentId: 'inc-1', startedAt: '2026-10-24T20:00:00Z', initialAt: null, shown: true, events: [row] })
    expect(result.current.moments).toContain(Date.parse('2026-10-24T20:20:00Z'))
  })
})
