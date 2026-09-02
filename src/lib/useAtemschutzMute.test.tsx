// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The audio layer, reduced to what the bell reads: a flag, and the statechange subscription.
const audio = vi.hoisted(() => ({ unlocked: false, listeners: new Set<() => void>() }))
vi.mock('./alarm', () => ({
  audioUnlocked: vi.fn(() => audio.unlocked),
  primeAudio: vi.fn(() => { audio.unlocked = true }),
  onAudioState: vi.fn((fn: () => void) => { audio.listeners.add(fn); return () => { audio.listeners.delete(fn) } }),
}))

import { useAtemschutzMute } from './useAtemschutzMute'
import { audioUnlocked } from './alarm'

const fireStateChange = () => { for (const fn of audio.listeners) fn() }

beforeEach(() => { vi.useFakeTimers(); audio.unlocked = false; audio.listeners.clear() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('useAtemschutzMute — the bell reads the real audio state', () => {
  it('flips back to «nicht freigegeben» when the context is taken away, and re-primes on the tap', () => {
    audio.unlocked = true
    const { result } = renderHook(() => useAtemschutzMute('inc1'))
    expect(result.current.audioBlocked).toBe(false)

    // a phone call: WebKit reports `interrupted`, the statechange arrives, the tone is silent
    audio.unlocked = false
    act(() => fireStateChange())
    expect(result.current.audioBlocked).toBe(true)

    // the bell's own tap is the gesture the browser waits for
    act(() => result.current.unlockAudio())
    expect(result.current.audioBlocked).toBe(false)
  })

  it('re-checks when the app comes back to the foreground', () => {
    audio.unlocked = true
    const { result } = renderHook(() => useAtemschutzMute('inc1'))
    audio.unlocked = false
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(result.current.audioBlocked).toBe(true)
  })

  it('stops the backstop poll after the first resume re-check on a device whose audio never unlocks', () => {
    const { result } = renderHook(() => useAtemschutzMute('inc1'))
    expect(result.current.audioBlocked).toBe(true)
    vi.mocked(audioUnlocked).mockClear()
    act(() => { vi.advanceTimersByTime(4_500) })
    expect(vi.mocked(audioUnlocked).mock.calls.length).toBe(2) // 2 s cadence while blocked

    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.mocked(audioUnlocked).mockClear()
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(vi.mocked(audioUnlocked)).not.toHaveBeenCalled() // a pure viewer is not polled for good
    expect(result.current.audioBlocked).toBe(true)
  })

  it('a muted bell never claims a blocked tone — one warning about the same silence is enough', () => {
    const { result } = renderHook(() => useAtemschutzMute('inc1'))
    act(() => result.current.mute())
    expect(result.current.muted).toBe(true)
    expect(result.current.audioBlocked).toBe(false)
  })
})
