// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMittelActions } from './useMittelActions'
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
