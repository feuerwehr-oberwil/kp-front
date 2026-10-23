// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, useEffect } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { trailStep, useHistoryTrail } from './historyTrail'
import { appHistoryDepth, leaveAppEntries, navigateTo } from '../objectVisits/route'

// The library's levels as history entries (owner 20.10.2026: the native back steps up one
// section). What counts: one entry per level deeper, none for a sibling, the user's back moves
// one level, and nothing stays behind once the surface is gone (route · the 05.10. rule).

const same = (a: string | null, b: string | null) => a === b
/** let the microtask go() schedules run, and any traversal land */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

afterEach(async () => { cleanup(); await settle(); vi.restoreAllMocks() })

describe('trailStep', () => {
  const trail = [null, 'TLF', 'ch3']
  it('goes deeper by pushing', () => {
    expect(trailStep([null], 0, [null, 'TLF', 'ch3'], same)).toEqual({ back: 0, push: 2 })
  })
  it('a sibling replaces its level', () => {
    expect(trailStep(trail, 2, [null, 'TLF', 'ch4'], same)).toEqual({ back: 0, push: 0 })
  })
  it('up is one walk back', () => {
    expect(trailStep(trail, 2, [null, 'TLF'], same)).toEqual({ back: 1, push: 0 })
    expect(trailStep(trail, 2, [null], same)).toEqual({ back: 2, push: 0 })
  })
  it('another branch walks back to the common level, then pushes', () => {
    expect(trailStep(trail, 2, [null, 'MS', 'ch1'], same)).toEqual({ back: 1, push: 1 })
    // the tablet: no list level, so a new top level replaces level 0
    expect(trailStep(['TLF', 'ch3'], 1, ['Generator'], same)).toEqual({ back: 1, push: 0 })
  })
})

describe('useHistoryTrail', () => {
  const start = async () => {
    window.history.replaceState(null, '', '/karte')
    const hook = renderHook(() => useHistoryTrail<string | null>(null, same))
    await settle()
    return hook
  }

  it('one entry per level deeper; the back gesture steps up one', async () => {
    const { result } = await start()
    act(() => result.current.go([null, 'TLF', 'ch3']))
    expect(result.current.at).toBe('ch3') // shown at once
    await settle()
    expect(appHistoryDepth()).toBe(2)
    act(() => window.history.back())
    await settle()
    expect(result.current.at).toBe('TLF')
    expect(appHistoryDepth()).toBe(1)
  })

  it('survives StrictMode\'s mount → clean-up → mount (the app runs in it, main.tsx)', async () => {
    window.history.replaceState(null, '', '/karte')
    // a restored page re-chains in an effect (ChecklistLibrary), which StrictMode runs twice
    const { result } = renderHook(() => {
      const t = useHistoryTrail<string | null>('ch3', same)
      const { go } = t
      useEffect(() => go([null, 'TLF', 'ch3']), [go])
      return t
    }, { wrapper: StrictMode })
    await settle()
    expect(appHistoryDepth()).toBe(2)
    act(() => window.history.back())
    await settle()
    expect(result.current.at).toBe('TLF')
  })

  it('a sibling leaves the history alone; the back row walks it', async () => {
    const { result } = await start()
    act(() => result.current.go([null, 'TLF', 'ch3']))
    await settle()
    const len = window.history.length
    act(() => result.current.go([null, 'TLF', 'ch4']))
    await settle()
    expect([appHistoryDepth(), window.history.length]).toEqual([2, len])
    act(() => result.current.go([null, 'TLF'])) // «‹ TLF»
    await settle()
    expect([result.current.at, appHistoryDepth()]).toEqual(['TLF', 1])
  })

  it('leaving walks its entries back – nothing behind the screen it hands over to', async () => {
    const { result, unmount } = await start()
    act(() => result.current.go([null, 'TLF', 'ch3']))
    await settle()
    unmount()
    await settle()
    expect(appHistoryDepth()).toBe(0)
    expect(window.location.pathname).toBe('/karte')
  })

  it('…but not under a visit pushed on top: the visit walks them back itself', async () => {
    const { result, unmount } = await start()
    act(() => result.current.go([null, 'TLF']))
    await settle()
    navigateTo('/besuche/neu?object=x') // the Karte hands over with a push
    unmount()
    await settle()
    expect(window.location.pathname).toBe('/besuche/neu')
    leaveAppEntries('/karte')
    await settle()
    expect([window.location.pathname, appHistoryDepth()]).toEqual(['/karte', 0])
  })

  it('…and never twice when the app is already walking to its floor', async () => {
    const { result, unmount } = await start()
    act(() => result.current.go([null, 'TLF', 'ch3']))
    await settle()
    // two walks at once go too far in a browser (each computed from the same stale depth)
    const go = vi.spyOn(window.history, 'go')
    leaveAppEntries('/') // an Einsatz opened from the Karte: App walks every entry back
    unmount()
    await settle()
    expect(go.mock.calls).toEqual([[-2]])
    expect([window.location.pathname, appHistoryDepth()]).toEqual(['/', 0])
  })
})
