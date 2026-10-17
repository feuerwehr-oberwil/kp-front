// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { MIN_KEYBOARD_PX, keySheetBox, keyboardTop, mayCorrect, useTypingLock } from './iosKeyboard'

/* Review round 3 (owner's iPhone, 17.10.2026): the phone's field sheets stand on the keyboard by
 * their own measurement, and the page never moves while a field has the caret. */

describe('keyboardTop — where the keys begin, in layout px', () => {
  it('is the visual viewport\'s bottom on iOS (the keyboard never shrinks innerHeight)', () => {
    expect(keyboardTop({ innerHeight: 844, vvHeight: 377, vvOffsetTop: 0 })).toBe(377)
    // a pan iOS reports as offsetTop moves the band, not the keys' height
    expect(keyboardTop({ innerHeight: 844, vvHeight: 377, vvOffsetTop: 60 })).toBe(437)
  })
  it('is null without a keyboard, for the address bar\'s few px, and on a pinch-zoomed page', () => {
    expect(keyboardTop({ innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 })).toBeNull()
    expect(keyboardTop({ innerHeight: 844, vvHeight: 844 - MIN_KEYBOARD_PX + 1, vvOffsetTop: 0 })).toBeNull()
    expect(keyboardTop({ innerHeight: 844, vvHeight: 300, vvOffsetTop: 0, scale: 2 })).toBeNull()
  })
  it('takes Android\'s VirtualKeyboard height first (overlays-content: the viewport does not shrink)', () => {
    expect(keyboardTop({ innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vkHeight: 300 })).toBe(500)
    expect(keyboardTop({ innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vkHeight: 20 })).toBeNull()
  })
  it('never reads past the layout viewport', () => {
    expect(keyboardTop({ innerHeight: 844, vvHeight: 700, vvOffsetTop: 400 })).toBeNull()
  })
})

describe('keySheetBox — the sheet ON the keys, under the top bar, a strip of map above it', () => {
  const at = (kbTop: number | null) => keySheetBox({ innerHeight: 844, kbTop, barBottom: 114, strip: 24, minHeight: 132 })
  it('puts the sheet\'s foot on the keyboard\'s top edge and caps it at the room above', () => {
    // the owner's iPhone, numeric pad + accessory bar: 467 px of keyboard
    expect(at(377)).toEqual({ bottom: 467, maxHeight: 239 })
  })
  it('keeps the field usable on the smallest band', () => {
    expect(at(200)).toEqual({ bottom: 644, maxHeight: 132 })
  })
  it('is nothing without a keyboard — the sheet is its normal Ebenen self', () => {
    expect(at(null)).toBeNull()
  })
})

describe('mayCorrect — undoing iOS\'s pan never becomes a loop', () => {
  it('allows a few corrections a second, then lets iOS have its way, and recovers', () => {
    let h: number[] = []
    const oks: boolean[] = []
    for (let i = 0; i < 8; i++) { const r = mayCorrect(h, 1000 + i * 10); h = r.history; oks.push(r.ok) }
    expect(oks).toEqual([true, true, true, true, true, true, false, false])
    expect(mayCorrect(h, 3000).ok).toBe(true)
  })
})

describe('useTypingLock', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks() })

  function touch(el: Element, type: string, y: number) {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'touches', { value: [{ clientX: 10, clientY: y }] })
    el.dispatchEvent(e)
    return e
  }

  it('cancels a drag over something that cannot scroll while a field has the caret — and only then', () => {
    const bar = document.createElement('div')
    const input = document.createElement('input')
    document.body.append(bar, input)
    renderHook(() => useTypingLock(true))
    touch(bar, 'touchstart', 300)
    expect(touch(bar, 'touchmove', 200).defaultPrevented).toBe(false)
    input.focus()
    touch(bar, 'touchstart', 300)
    expect(touch(bar, 'touchmove', 200).defaultPrevented).toBe(true)
    // the field itself keeps its gesture (selecting text)
    touch(input, 'touchstart', 300)
    expect(touch(input, 'touchmove', 200).defaultPrevented).toBe(false)
  })

  it('answers a page scroll with scrollTo(0, 0)', () => {
    vi.useFakeTimers()
    const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    renderHook(() => useTypingLock(true))
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 120 })
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(50)
    expect(to).toHaveBeenCalledWith(0, 0)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    vi.useRealTimers()
  })

  it('does nothing while disabled (the tablet)', () => {
    const bar = document.createElement('div')
    const input = document.createElement('input')
    document.body.append(bar, input)
    renderHook(() => useTypingLock(false))
    input.focus()
    touch(bar, 'touchstart', 300)
    expect(touch(bar, 'touchmove', 200).defaultPrevented).toBe(false)
  })
})
