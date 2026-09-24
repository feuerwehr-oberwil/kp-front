// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setLiveBearing, useLiveBearing } from './liveBearing'

afterEach(() => { act(() => setLiveBearing(null)) })

describe('liveBearing — the wind arrow turns with the finger', () => {
  it('falls back to the settled bearing while no Karte is mounted', () => {
    const { result } = renderHook(() => useLiveBearing(42))
    expect(result.current).toBe(42)
  })

  it('follows every rotate frame, not only the end of the gesture', () => {
    const { result } = renderHook(() => useLiveBearing(0))
    act(() => setLiveBearing(10))
    expect(result.current).toBe(10)
    act(() => setLiveBearing(27.5))
    expect(result.current).toBe(27.5)
  })

  it('a live bearing of 0 is a bearing, not «no Karte»', () => {
    const { result } = renderHook(() => useLiveBearing(90))
    act(() => setLiveBearing(0))
    expect(result.current).toBe(0)
  })

  it('hands back to the fallback once the Karte unmounts', () => {
    const { result } = renderHook(() => useLiveBearing(15))
    act(() => setLiveBearing(200))
    act(() => setLiveBearing(null))
    expect(result.current).toBe(15)
  })
})
