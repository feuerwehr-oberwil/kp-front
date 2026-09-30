// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useViewportPan } from './useViewportPan'

/* 30.09.2026, staging phone pass: the Rapport ended ~115px above the iOS keyboard and the Trupp
 * sheet stood off it. The hook publishes the visible band to CSS — `--vv-pan` (its top: how far
 * iOS panned) and `--vv-foot` (the layout viewport's hidden foot: the keyboard less that pan) —
 * plus `data-kb` while a keyboard is up, one write per frame and never a render. */
class FakeViewport extends EventTarget {
  constructor(public height: number, public offsetTop = 0, public scale = 1) { super() }
  set(height: number, offsetTop: number) { this.height = height; this.offsetTop = offsetTop; this.dispatchEvent(new Event('resize')); this.dispatchEvent(new Event('scroll')) }
}
const SCREEN = 800
const root = document.documentElement
const settle = () => act(() => { vi.advanceTimersByTime(50) })

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

describe('useViewportPan — the visible band, as CSS', () => {
  it('writes the pan, the foot and data-kb while a field has the caret, and clears them after', () => {
    vi.useFakeTimers()
    const vv = new FakeViewport(SCREEN)
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    window.innerHeight = SCREEN
    const field = document.createElement('textarea')
    document.body.append(field)
    const { unmount } = renderHook(() => useViewportPan())
    settle()
    expect(root.style.getPropertyValue('--vv-foot')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(false)
    field.focus()
    act(() => vv.set(SCREEN - 300, 200)); settle()
    expect(root.style.getPropertyValue('--vv-pan')).toBe('200px')
    expect(root.style.getPropertyValue('--vv-foot')).toBe('100px')
    expect(root.hasAttribute('data-kb')).toBe(true)
    // the field lets go while iOS reports nothing yet: no caret, no keyboard
    act(() => { field.blur() }); settle()
    expect(root.style.getPropertyValue('--vv-foot')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(false)
    unmount()
    expect(root.style.getPropertyValue('--vv-foot')).toBe('')
    expect(root.style.getPropertyValue('--vv-pan')).toBe('')
  })
  it('keeps data-kb while the pan has swallowed the whole keyboard (foot 0)', () => {
    vi.useFakeTimers()
    const vv = new FakeViewport(SCREEN)
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    window.innerHeight = SCREEN
    const field = document.createElement('textarea')
    document.body.append(field)
    const { unmount } = renderHook(() => useViewportPan())
    field.focus()
    act(() => vv.set(SCREEN - 300, 300)); settle()
    expect(root.style.getPropertyValue('--vv-foot')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(true)
    unmount()
    expect(root.hasAttribute('data-kb')).toBe(false)
  })
})
