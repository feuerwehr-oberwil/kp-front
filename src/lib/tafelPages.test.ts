// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SKIZZE, resetTafelPageMemory, stepPage, useTafelPage } from './tafelPages'

describe('which Tafel page this device has open', () => {
  it('is remembered per Einsatz across a reload (IndexedDB), never shared', async () => {
    resetTafelPageMemory()
    const a = renderHook(() => useTafelPage('inc-1'))
    expect(a.result.current[0]).toBe(SKIZZE)
    act(() => a.result.current[1]('fm-ef'))
    expect(a.result.current[0]).toBe('fm-ef')
    a.unmount()
    // a reload: the session memory is gone, the device's store is not
    resetTafelPageMemory()
    const b = renderHook(() => useTafelPage('inc-1'))
    await waitFor(() => expect(b.result.current[0]).toBe('fm-ef'))
    // another Einsatz starts on the Skizze
    const c = renderHook(() => useTafelPage('inc-2'))
    expect(c.result.current[0]).toBe(SKIZZE)
  })
  it('PageUp / PageDown stop at the ends', () => {
    expect([stepPage(['s', 'a', 'b'], 'a', 1), stepPage(['s', 'a', 'b'], 'b', 1), stepPage(['s', 'a'], 's', -1)]).toEqual(['b', 'b', 's'])
  })
})
