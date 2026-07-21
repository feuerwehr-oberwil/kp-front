// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { createRef } from 'react'
import { swipeOutcome, useSectionSwipe } from './useSectionSwipe'

afterEach(cleanup)

describe('swipeOutcome (pure decision)', () => {
  it('pages next on a clear leftward drag', () => {
    expect(swipeOutcome(-80, 10)).toBe('next')
  })
  it('pages previous on a clear rightward drag', () => {
    expect(swipeOutcome(80, -8)).toBe('prev')
  })
  it('bails to scroll on a mostly-vertical drag', () => {
    expect(swipeOutcome(10, 60)).toBe('bail')
  })
  it('returns null below the horizontal threshold', () => {
    expect(swipeOutcome(-40, 5)).toBeNull()
  })
  it('returns null for a diagonal drag that neither dominates nor bails', () => {
    expect(swipeOutcome(30, 12)).toBeNull() // dx below threshold, dy below bail
  })
})

// jsdom Touch/TouchEvent helpers (jsdom has no Touch ctor).
function touch(target: EventTarget, type: string, x: number, y: number, opts: EventInit = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true, ...opts }) as TouchEvent & { touches: unknown }
  const t = { clientX: x, clientY: y, target }
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [t] })
  Object.defineProperty(e, 'target', { value: target })
  return e
}

describe('useSectionSwipe (native touch)', () => {
  function mount(enabled = true) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ref = createRef<HTMLDivElement>()
    ;(ref as { current: HTMLDivElement }).current = el
    const onPrev = vi.fn(), onNext = vi.fn()
    renderHook(() => useSectionSwipe(ref, { enabled, onPrev, onNext }))
    return { el, onPrev, onNext }
  }

  it('fires next on a horizontal touch drag left', () => {
    const { el, onNext } = mount()
    el.dispatchEvent(touch(el, 'touchstart', 300, 400))
    el.dispatchEvent(touch(el, 'touchmove', 220, 405))
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('does not fire on a vertical drag (scroll)', () => {
    const { el, onNext, onPrev } = mount()
    el.dispatchEvent(touch(el, 'touchstart', 200, 200))
    el.dispatchEvent(touch(el, 'touchmove', 210, 300))
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('fires only once per gesture', () => {
    const { el, onNext } = mount()
    el.dispatchEvent(touch(el, 'touchstart', 300, 400))
    el.dispatchEvent(touch(el, 'touchmove', 220, 405))
    el.dispatchEvent(touch(el, 'touchmove', 120, 405))
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', () => {
    const { el, onNext } = mount(false)
    el.dispatchEvent(touch(el, 'touchstart', 300, 400))
    el.dispatchEvent(touch(el, 'touchmove', 120, 405))
    expect(onNext).not.toHaveBeenCalled()
  })
})
