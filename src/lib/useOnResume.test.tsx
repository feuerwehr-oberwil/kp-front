// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOnResume } from './useOnResume'

const setVisibility = (v: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => setVisibility('visible'))

describe('useOnResume', () => {
  it('fires once on the way back from the background, and not on a visible → visible event', () => {
    const fn = vi.fn()
    renderHook(() => useOnResume(fn))
    setVisibility('visible')
    expect(fn).not.toHaveBeenCalled()
    setVisibility('hidden')
    expect(fn).not.toHaveBeenCalled()
    setVisibility('visible')
    setVisibility('visible')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('calls the latest callback, and nothing after unmount', () => {
    const a = vi.fn(), b = vi.fn()
    const { rerender, unmount } = renderHook(({ cb }) => useOnResume(cb), { initialProps: { cb: a } })
    rerender({ cb: b })
    setVisibility('hidden'); setVisibility('visible')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    unmount()
    setVisibility('hidden'); setVisibility('visible')
    expect(b).toHaveBeenCalledTimes(1)
  })
})
