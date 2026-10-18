// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { MIN_KEYBOARD_PX, focusWithoutPan, keySheetBox, keyboardTop, mayCorrect, useTypingLock } from './iosKeyboard'

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
  it('keeps the sheet\'s top where it was on the SCREEN when iOS pans the page anyway (round 5)', () => {
    // panned by 90: the keys' top edge is 90 lower in layout px, the bar rides down by 90 (--vv-pan)
    const panned = keySheetBox({ innerHeight: 844, kbTop: 377 + 90, barBottom: 114, strip: 24, minHeight: 132, pan: 90 })
    expect(panned).toEqual({ bottom: 467 - 90, maxHeight: 239 })
    // the top on the screen: layout top (innerHeight − bottom − height) less the pan — unchanged
    const top = (b: { bottom: number; maxHeight: number }, pan: number) => 844 - b.bottom - b.maxHeight - pan
    expect(top(panned!, 90)).toBe(top(at(377)!, 0))
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

describe('focusWithoutPan', () => {
  it('focuses, and gives the field its own transform back even when called twice in one frame (StrictMode)', () => {
    vi.useFakeTimers()
    const el = document.createElement('input')
    el.style.transform = 'scale(1)'
    document.body.append(el)
    focusWithoutPan(el)
    focusWithoutPan(el)
    expect(document.activeElement).toBe(el)
    expect(el.style.transform).toBe('translateY(-2000px)')
    vi.advanceTimersByTime(50)
    expect(el.style.transform).toBe('scale(1)')
    vi.useRealTimers()
    el.remove()
  })
})

describe('useTypingLock', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks() })

  function touch(el: Element, type: string, y: number, x = 10) {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
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

  it('lets a list scroll whose first move is a pixel sideways (review round 5) — one decision per touch', () => {
    // the search's result list: a vertical scroller with room below
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    Object.defineProperties(list, { scrollHeight: { value: 900 }, clientHeight: { value: 400 } })
    const row = document.createElement('button')
    list.append(row)
    const input = document.createElement('input')
    document.body.append(list, input)
    renderHook(() => useTypingLock(true))
    input.focus()
    touch(row, 'touchstart', 300, 100)
    // iOS keys its native pan on the FIRST touchmove: cancelling it kills the scroll for the touch
    expect(touch(row, 'touchmove', 300, 101).defaultPrevented).toBe(false)
    expect(touch(row, 'touchmove', 290, 102).defaultPrevented).toBe(false)
    expect(touch(row, 'touchmove', 250, 102).defaultPrevented).toBe(false)
    // …and a pull down at the list's top is still cancelled (nothing to scroll, the page would move)
    touch(row, 'touchstart', 300, 100)
    expect(touch(row, 'touchmove', 320, 100).defaultPrevented).toBe(true)
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
