// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMittelActions } from './useMittelActions'
import { mergeWorkspace } from './mergeWorkspace'
import { simulatedDevice } from './devices.test-utils'
import type { MittelEntry } from '../types'

// A settled Mittel count says where the number came FROM («… (vorher 3)»), because the Verlauf is
// read on paper to see what happened, not to see what is currently in the depot. The pre-burst
// total is the interesting one: five taps on ± are five saves, and each reads what the tap before
// it wrote.

function harness(initial: MittelEntry[] = []) {
  const log = vi.fn()
  let mittel = initial
  const { result, rerender } = renderHook(() =>
    useMittelActions({
      mittel,
      setMittel: (u) => { mittel = typeof u === 'function' ? u(mittel) : u; rerender() },
      authorName: 'Muster Hans',
      log,
    }),
  )
  return { result, log, rows: () => log.mock.calls.map((c) => c[1] as string) }
}

// ⚠️ Dated well in the past: the current line for a key is the LATEST event by `at`
// (lib/mittel · deriveCurrentMittel), so a seed stamped in the future would outrank every row
// the hook then writes and the test would measure nothing.
const entry = (menge: number): MittelEntry =>
  ({ id: 'm0', label: 'Schlauch 75er', unit: 'Stk.', menge, at: '2020-01-01T00:00:00.000Z' }) as MittelEntry

const draft = (menge: number) => ({ label: 'Schlauch 75er', unit: 'Stk.', menge })

describe('useMittelActions · the settled count row', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says what the total moved from', () => {
    const h = harness([entry(3)])
    act(() => { h.result.current.saveMittel(draft(5)) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(h.rows()).toEqual(['Schlauch 75er: 5 Stk. (vorher 3)'])
  })

  it('keeps the FIRST «vorher» of a burst, not the value the previous tap wrote', () => {
    const h = harness([entry(8)])
    act(() => { h.result.current.saveMittel(draft(7)) })
    act(() => { h.result.current.saveMittel(draft(6)) })
    act(() => { h.result.current.saveMittel(draft(5)) })
    act(() => { vi.advanceTimersByTime(3000) })
    // one row for the burst, and it reports the total the operator started dialling from
    expect(h.rows()).toEqual(['Schlauch 75er: 5 Stk. (vorher 8)'])
  })

  it('says nothing about «vorher» for a position recorded for the first time', () => {
    const h = harness([])
    act(() => { h.result.current.saveMittel(draft(4)) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(h.rows()).toEqual(['Schlauch 75er: 4 Stk.'])
  })
})

// Post-mortem 23.09.2026: `m${Date.now()}-${list.length}` — two devices holding the same list
// length minted the same id in one millisecond, and the workspace merge (by id) folded two
// materials into one.
describe('useMittelActions · two devices, one millisecond', () => {
  afterEach(() => vi.useRealTimers())

  it('mints distinct ids, and the merge keeps both materials', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T19:04:05.123Z'))
    const base = [entry(3)] // both devices start from the same synced list — same length
    const onDevice = async (seed: number, d: ReturnType<typeof draft>) => {
      const dev = await simulatedDevice(seed, () => import('./useMittelActions'))
      let mittel = base
      const { result } = renderHook(() => dev.mod.useMittelActions({
        mittel, setMittel: (u) => { mittel = typeof u === 'function' ? u(mittel) : u }, authorName: undefined, log: vi.fn(),
      }))
      dev.run(() => act(() => { result.current.saveMittel(d) }))
      return mittel
    }
    const a = await onDevice(1, { label: 'Ölbinder', unit: 'Sack', menge: 2 })
    const b = await onDevice(2, { label: 'Tauchpumpe', unit: 'Stk.', menge: 1 })
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    expect(a[1].id).not.toBe(b[1].id)
    const merged = mergeWorkspace({ mittel: base }, { mittel: a }, { mittel: b }).mittel as MittelEntry[]
    expect(merged.map((m) => m.label).sort()).toEqual(['Schlauch 75er', 'Tauchpumpe', 'Ölbinder'])
  })
})
