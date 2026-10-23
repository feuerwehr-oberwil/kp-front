// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { DRAG_SLOP_PX, KS_MOVE_MS, MIN_KEYBOARD_PX, focusWithoutPan, fullViewHeight, isCollapseScroll, isListDrag, keySheetBox, keyboardTop, mayCorrect, useDragClosesKeyboard, useKeySheet, useTypingLock } from './iosKeyboard'

/* Review round 3 (owner's iPhone, 17.10.2026): the phone's field sheets stand on the keyboard by
 * their own measurement, and the page never moves while a field has the caret. */

describe('keyboardTop — where the keys begin, in layout px', () => {
  it('is the visual viewport\'s bottom on iOS (the keyboard never shrinks innerHeight)', () => {
    expect(keyboardTop({ viewHeight: 844, vvHeight: 377, vvOffsetTop: 0 })).toBe(377)
    // a pan iOS reports as offsetTop moves the band, not the keys' height
    expect(keyboardTop({ viewHeight: 844, vvHeight: 377, vvOffsetTop: 60 })).toBe(437)
  })
  it('is null without a keyboard, for the address bar\'s few px, and on a pinch-zoomed page', () => {
    expect(keyboardTop({ viewHeight: 844, vvHeight: 844, vvOffsetTop: 0 })).toBeNull()
    expect(keyboardTop({ viewHeight: 844, vvHeight: 844 - MIN_KEYBOARD_PX + 1, vvOffsetTop: 0 })).toBeNull()
    expect(keyboardTop({ viewHeight: 844, vvHeight: 300, vvOffsetTop: 0, scale: 2 })).toBeNull()
  })
  it('takes Android\'s VirtualKeyboard height first (overlays-content: the viewport does not shrink)', () => {
    expect(keyboardTop({ viewHeight: 800, vvHeight: 800, vvOffsetTop: 0, vkHeight: 300 })).toBe(500)
    expect(keyboardTop({ viewHeight: 800, vvHeight: 800, vvOffsetTop: 0, vkHeight: 20 })).toBeNull()
  })
  it('never reads past the frame\'s foot', () => {
    expect(keyboardTop({ viewHeight: 844, vvHeight: 700, vvOffsetTop: 400 })).toBe(844)
  })
})

/* Review round 9, the owner's readout in the INSTALLED app (393×793 under the status bar): before
 * the touch innerHeight 793, vv 424, pan 0; once the finger is down innerHeight 424, vv 424, pan
 * and scrollY 369 — the document and the fixed frame still 793. */
// round 9
describe('the installed app\'s collapse', () => {
  const box = (kbTop: number | null, pan: number) => keySheetBox({ viewHeight: 793, kbTop, barBottom: 68, strip: 24, minHeight: 132, pan })
  // the sheet's top on the screen: frame top (793 − bottom − height) less the pan
  const top = (b: { bottom: number; maxHeight: number }, pan: number) => 793 - b.bottom - b.maxHeight - pan

  it('read from the live innerHeight, the keyboard vanished — the sheet lost its placement', () => {
    expect(keyboardTop({ viewHeight: 424, vvHeight: 424, vvOffsetTop: 369 })).toBeNull()
  })
  it('from the full height the keys stay up, before and after, and the sheet keeps its place on the screen', () => {
    const before = keyboardTop({ viewHeight: 793, vvHeight: 424, vvOffsetTop: 0 })
    const after = keyboardTop({ viewHeight: 793, vvHeight: 424, vvOffsetTop: 369 })
    expect(before).toBe(424)
    expect(after).toBe(793)
    // the owner's readout before the touch: «sheet on 369px/332px», its top at 92 on the screen
    expect(box(before, 0)).toEqual({ bottom: 369, maxHeight: 332 })
    // after: its foot on the frame's foot — the keys' top edge on the screen — and the same top
    expect(box(after, 369)).toEqual({ bottom: 0, maxHeight: 332 })
    expect(top(box(after, 369)!, 369)).toBe(top(box(before, 0)!, 0))
    expect(top(box(before, 0)!, 0)).toBe(92)
  })
  it('the full height is the larger of innerHeight and the root\'s client height', () => {
    const inner = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(424)
    const client = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(793)
    expect(fullViewHeight()).toBe(793)
    inner.mockReturnValue(844)
    expect(fullViewHeight()).toBe(844)
    inner.mockRestore(); client.mockRestore()
  })
})

/* Review round 10, the owner's readout: while the finger is down iOS collapses innerHeight in
 * steps and scrolls the window by exactly the collapse — 82 = 793 − 711, 8 = 793 − 785. */
// round 10
describe('isCollapseScroll — the installed app\'s stepped collapse', () => {
  it('is a scroll no larger than the shrink of innerHeight below the full height', () => {
    expect(isCollapseScroll({ full: 793, inner: 711, pan: 82 })).toBe(true)
    expect(isCollapseScroll({ full: 793, inner: 785, pan: 8 })).toBe(true)
    expect(isCollapseScroll({ full: 793, inner: 424, pan: 369 })).toBe(true)
  })
  it('is not a pan of a full-height window (a Safari tab bringing a field into sight), nor a larger scroll', () => {
    expect(isCollapseScroll({ full: 844, inner: 844, pan: 60 })).toBe(false)
    expect(isCollapseScroll({ full: 793, inner: 711, pan: 200 })).toBe(false)
    expect(isCollapseScroll({ full: 793, inner: 711, pan: 0 })).toBe(false)
  })
})

describe('keySheetBox — the sheet ON the keys, under the top bar, a strip of map above it', () => {
  const at = (kbTop: number | null) => keySheetBox({ viewHeight: 844, kbTop, barBottom: 114, strip: 24, minHeight: 132 })
  it('puts the sheet\'s foot on the keyboard\'s top edge and caps it at the room above', () => {
    // the owner's iPhone, numeric pad + accessory bar: 467 px of keyboard
    expect(at(377)).toEqual({ bottom: 467, maxHeight: 239 })
  })
  // round 5
  it('keeps the sheet\'s top where it was on the SCREEN when iOS pans the page anyway', () => {
    // panned by 90: the keys' top edge is 90 lower in layout px, the bar rides down by 90 (--vv-pan)
    const panned = keySheetBox({ viewHeight: 844, kbTop: 377 + 90, barBottom: 114, strip: 24, minHeight: 132, pan: 90 })
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

  // review round 5
  it('lets a list scroll whose first move is a pixel sideways — one decision per touch', () => {
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

  // round 11
  it('never cancels a drag on a list that closes the keyboard on drag, even pulling down at its top', () => {
    const list = document.createElement('div')
    list.setAttribute('data-drag-closes-keys', '')
    list.style.overflowY = 'auto'
    Object.defineProperties(list, { scrollHeight: { value: 900 }, clientHeight: { value: 400 } })
    const row = document.createElement('button')
    list.append(row)
    const input = document.createElement('input')
    document.body.append(list, input)
    renderHook(() => useTypingLock(true))
    input.focus()
    touch(row, 'touchstart', 300, 100)
    expect(touch(row, 'touchmove', 302, 100).defaultPrevented).toBe(false)
    expect(touch(row, 'touchmove', 320, 100).defaultPrevented).toBe(false)
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

  // round 9
  it('looks again after a touch with the caret up — the installed app\'s collapse scrolls and then fires nothing', () => {
    vi.useFakeTimers()
    const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const input = document.createElement('input')
    document.body.append(input)
    renderHook(() => useTypingLock(true))
    input.focus()
    vi.advanceTimersByTime(1000)
    to.mockClear()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 369 })
    touch(input, 'touchend', 300)
    vi.advanceTimersByTime(300)
    expect(to).toHaveBeenCalledWith(0, 0)
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    vi.useRealTimers()
  })

  // round 10
  it('undoes the stepped collapse IN the scroll event, every step — not a frame later, not six and done', () => {
    const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const inner = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(793)
    const client = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(793)
    renderHook(() => useTypingLock(true))
    for (const h of [756, 711, 690, 666, 690, 740, 782, 785, 711, 666]) {
      inner.mockReturnValue(h)
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 793 - h })
      to.mockClear()
      window.dispatchEvent(new Event('scroll'))
      expect(to).toHaveBeenCalledWith(0, 0)
    }
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    inner.mockRestore(); client.mockRestore()
  })

  // round 10
  it('binds the root to the live window height while on, and lets go when off', () => {
    const inner = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(793)
    const root = document.documentElement
    const { unmount } = renderHook(() => useTypingLock(true))
    expect(root.hasAttribute('data-typing-lock')).toBe(true)
    expect(root.style.getPropertyValue('--live-h')).toBe('793px')
    inner.mockReturnValue(711)
    window.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--live-h')).toBe('711px')
    unmount()
    expect(root.hasAttribute('data-typing-lock')).toBe(false)
    expect(root.style.getPropertyValue('--live-h')).toBe('')
    inner.mockRestore()
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

/* Review round 11, the owner's pick: a drag on the sheet's list closes the keyboard (iOS Mail's
 * search); a tap on a row does not. */
describe('isListDrag — a tap, or the drag that closes the keyboard', () => {
  it('is a drag once the finger has gone DRAG_SLOP_PX up or down, more than sideways', () => {
    expect(isListDrag(0, DRAG_SLOP_PX)).toBe(true)
    expect(isListDrag(2, -DRAG_SLOP_PX - 4)).toBe(true)
  })
  it('is no drag for a tap\'s wobble or a sideways swipe', () => {
    expect(isListDrag(0, 0)).toBe(false)
    expect(isListDrag(3, DRAG_SLOP_PX - 1)).toBe(false)
    expect(isListDrag(20, 12)).toBe(false)
    expect(isListDrag(10, -10)).toBe(false)
  })
})

describe('useDragClosesKeyboard', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren() })
  // a sheet: the field in its head, a row in its body
  function sheet() {
    const el = document.createElement('section')
    el.innerHTML = '<div class="head"><input /></div><div class="lc-body"><button>ARA Birsig</button></div>'
    document.body.append(el)
    const input = el.querySelector('input')!, row = el.querySelector('button')!, head = el.querySelector('.head')!
    renderHook(() => useDragClosesKeyboard({ current: el }, '.lc-body'))
    input.focus()
    return { input, row, head }
  }
  /** one touch from (100, 300) through `moves` (total offsets); returns whether any move was cancelled */
  function touch(el: Element, ...moves: [number, number][]) {
    const fire = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
      el.dispatchEvent(e)
      return e.defaultPrevented
    }
    fire('touchstart', 100, 300)
    return moves.map(([dx, dy]) => fire('touchmove', 100 + dx, 300 + dy)).some(Boolean)
  }

  it('blurs the field on a drag over the list, either way, and never cancels the touch', () => {
    const { input, row } = sheet()
    expect(touch(row, [0, -3], [0, -12], [0, -30])).toBe(false)
    expect(document.activeElement).not.toBe(input)
    input.focus()
    touch(row, [1, 4], [1, 10])
    expect(document.activeElement).not.toBe(input)
  })
  it('keeps the caret for a tap\'s wobble on a row, a sideways swipe and a drag on the head', () => {
    const { input, row, head } = sheet()
    touch(row, [1, 2], [-2, 4])
    expect(document.activeElement).toBe(input)
    touch(row, [20, 4], [40, 6])
    expect(document.activeElement).toBe(input)
    touch(head, [0, 30])
    expect(document.activeElement).toBe(input)
  })
})

// review round 12
describe('useKeySheet · the glide between the two places', () => {
  afterEach(() => { cleanup(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('marks data-ks-move only while the keys come or go, never for a re-placement on the keys', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    // a keyboard stand-in: the visual viewport shrinks by `kb`, iOS pans it by `pan`
    const st = { kb: 0, pan: 0 }
    const vv = Object.defineProperties(new EventTarget(), {
      height: { get: () => window.innerHeight - st.kb }, offsetTop: { get: () => st.pan }, scale: { value: 1 },
    })
    vi.stubGlobal('visualViewport', vv)
    const kb = (patch: Partial<typeof st>) => { Object.assign(st, patch); vv.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20) }
    const el = document.createElement('section')
    el.innerHTML = '<input />'
    document.body.append(el)
    renderHook(() => useKeySheet({ current: el }))
    vi.advanceTimersByTime(20)
    expect(el.hasAttribute('data-ks-move')).toBe(false)
    el.querySelector('input')!.focus()
    kb({ kb: 336 })
    expect(el.hasAttribute('data-kb')).toBe(true)
    expect(el.hasAttribute('data-ks-move')).toBe(true)
    vi.advanceTimersByTime(KS_MOVE_MS)
    expect(el.hasAttribute('data-ks-move')).toBe(false)
    // iOS pans the page with the keys up: the sheet re-places at once
    kb({ pan: 90 })
    expect(el.style.getPropertyValue('--ks-max')).not.toBe('')
    expect(el.hasAttribute('data-ks-move')).toBe(false)
    // the keys go (the drag on the list blurred the field)
    el.querySelector('input')!.blur()
    kb({ kb: 0, pan: 0 })
    expect(el.hasAttribute('data-kb')).toBe(false)
    expect(el.hasAttribute('data-ks-move')).toBe(true)
  })
})
