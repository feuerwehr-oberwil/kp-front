// @vitest-environment jsdom
// The line under the intake picker's pin (sweep 30.10.2026 #5): the address the centre would
// bring, asked once the map rests, never an older centre's answer, coordinates when there is none.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LngLat } from '../types'
import { PICK_LOOKUP_MS, pickKey, pickLine, usePickAddress } from './mapPickAddress'

const a: LngLat = [7.56, 47.5]
const b: LngLat = [7.57, 47.51]

describe('pickLine', () => {
  it('says «looking» while the map moves or until THIS centre is answered', () => {
    expect(pickLine(null, null, true)).toEqual({ kind: 'looking' })
    expect(pickLine(a, { key: pickKey(b), label: 'Hauptstrasse 1' }, true)).toEqual({ kind: 'looking' })
  })
  it('the answer for this centre, or its coordinates when there is no address or no network', () => {
    expect(pickLine(a, { key: pickKey(a), label: 'Schlossgasse 9, 4103 Bottmingen' }, true)).toEqual({ kind: 'address', text: 'Schlossgasse 9, 4103 Bottmingen' })
    expect(pickLine(a, { key: pickKey(a), label: null }, true)).toEqual({ kind: 'coords', text: '47.50000, 7.56000' })
    expect(pickLine(a, null, false)).toEqual({ kind: 'coords', text: '47.50000, 7.56000' })
  })
})

describe('usePickAddress', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(PICK_LOOKUP_MS) })

  it('asks once for the centre the map rested on, not for every centre on the way', async () => {
    const lookup = vi.fn(async () => ({ label: 'Schlossgasse 9' }))
    const h = renderHook(({ at }) => usePickAddress(at, true, lookup), { initialProps: { at: a as LngLat | null } })
    h.rerender({ at: null }) // moving again before the delay ran out
    h.rerender({ at: b })
    await flush()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith(b[1], b[0])
    expect(h.result.current).toEqual({ kind: 'address', text: 'Schlossgasse 9' })
  })

  it('a failed lookup shows the coordinates; offline asks nothing', async () => {
    const failing = vi.fn(async () => { throw new Error('502') })
    const h = renderHook(() => usePickAddress(a, true, failing))
    await flush()
    expect(h.result.current).toEqual({ kind: 'coords', text: '47.50000, 7.56000' })
    const offline = vi.fn(async () => ({ label: 'x' }))
    const o = renderHook(() => usePickAddress(a, false, offline))
    await flush()
    expect(offline).not.toHaveBeenCalled()
    expect(o.result.current.kind).toBe('coords')
  })
})
