// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useKeyboardInset } from './useKeyboardInset'

/* Two regressions from the 08.09. Feldtest («Tastatur fehlt», and the Verlauf drawer floating in
 * the top half of the screen): a keyboard that CLOSES must always bring the inset back to 0.
 * The MIN_STEP dead-band may swallow small keyboard-open jitter, but never the way back — and
 * when iOS fires no visualViewport event at all for a dismissal, the focusout fallback must
 * re-measure on its own. */

/** The visual viewport, the way iOS reports it: the keyboard shrinks THIS, never `innerHeight`. */
class FakeViewport extends EventTarget {
  constructor(public height: number, public offsetTop = 0) { super() }
  resizeTo(height: number) { this.height = height; this.dispatchEvent(new Event('resize')) }
}

const SCREEN = 800

function stubViewport(): FakeViewport {
  const vv = new FakeViewport(SCREEN)
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
  window.innerHeight = SCREEN
  return vv
}

/** run the rAF-coalesced measure (jsdom backs rAF with timers, which are faked here) */
const settle = () => act(() => { vi.advanceTimersByTime(50) })

describe('useKeyboardInset — the way back to 0', () => {
  afterEach(() => { vi.useRealTimers() })

  it('commits a final step to 0 even when it is smaller than MIN_STEP', () => {
    vi.useFakeTimers()
    const vv = stubViewport()
    const { result } = renderHook(() => useKeyboardInset(true))
    act(() => vv.resizeTo(SCREEN - 300)); settle()
    expect(result.current).toBe(300)
    // iOS closes in stages: a big step down, then a sub-MIN_STEP hop onto exactly 0
    act(() => vv.resizeTo(SCREEN - 30)); settle()
    expect(result.current).toBe(30)
    act(() => vv.resizeTo(SCREEN)); settle()
    expect(result.current).toBe(0)
  })

  /* index.html ships `interactive-widget=overlays-content`; on Android that stops the keyboard
   * from resizing EITHER viewport, so `innerHeight - vv.height` reads 0 with the keyboard fully
   * up — the Journaleintrag composer sat behind it (Feldtest 09.09.). The VirtualKeyboard API is
   * the one source of geometry there. */
  it('reads the VirtualKeyboard API when neither viewport shrinks (Android overlays-content)', () => {
    vi.useFakeTimers()
    stubViewport() // full height, never changes — exactly what overlays-content does
    class FakeVk extends EventTarget {
      overlaysContent = false
      boundingRect = { height: 0 } as DOMRectReadOnly
      raise(height: number) {
        this.boundingRect = { height } as DOMRectReadOnly
        this.dispatchEvent(new Event('geometrychange'))
      }
    }
    const vk = new FakeVk()
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: vk })
    try {
      const { result } = renderHook(() => useKeyboardInset(true))
      expect(vk.overlaysContent).toBe(true) // the hook opts in, or the API reports nothing
      act(() => vk.raise(320)); settle()
      expect(result.current).toBe(320)
      act(() => vk.raise(0)); settle()
      expect(result.current).toBe(0)
    } finally {
      delete (navigator as Navigator & { virtualKeyboard?: unknown }).virtualKeyboard
    }
  })

  it('re-measures after focusout when the dismissal fired no viewport event', () => {
    vi.useFakeTimers()
    const vv = stubViewport()
    const { result } = renderHook(() => useKeyboardInset(true))
    act(() => vv.resizeTo(SCREEN - 300)); settle()
    expect(result.current).toBe(300)
    // scroll-to-dismiss: the viewport is back to full height but no resize/scroll event arrives
    vv.height = SCREEN
    act(() => { window.dispatchEvent(new Event('focusout')) })
    act(() => { vi.advanceTimersByTime(800) })
    expect(result.current).toBe(0)
  })
})
