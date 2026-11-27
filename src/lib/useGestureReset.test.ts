// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useGestureReset } from './useGestureReset'

describe('useGestureReset', () => {
  it('runs the latest reset on window blur and on unmount, and stops listening after', () => {
    const first = vi.fn(), latest = vi.fn()
    const { rerender, unmount } = renderHook(({ reset }) => useGestureReset(reset), { initialProps: { reset: first } })
    rerender({ reset: latest })
    window.dispatchEvent(new Event('blur'))
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
    unmount()
    expect(latest).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('blur'))
    expect(latest).toHaveBeenCalledTimes(2)
  })
})
