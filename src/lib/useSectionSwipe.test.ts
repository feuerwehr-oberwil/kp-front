// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useSectionSwipe } from './useSectionSwipe'

afterEach(cleanup)

type Ev = { clientX: number; clientY: number; pointerType?: string; target?: Partial<Element> }
const ev = (o: Ev) => ({ pointerType: 'touch', target: { closest: () => null }, ...o }) as unknown as React.PointerEvent

function setup(enabled = true) {
  const onPrev = vi.fn(), onNext = vi.fn()
  const { result } = renderHook(() => useSectionSwipe({ enabled, onPrev, onNext }))
  const swipe = (from: [number, number], to: [number, number], down: Partial<Ev> = {}) => {
    result.current.onPointerDown(ev({ clientX: from[0], clientY: from[1], ...down }))
    result.current.onPointerUp(ev({ clientX: to[0], clientY: to[1] }))
  }
  return { onPrev, onNext, swipe }
}

describe('useSectionSwipe', () => {
  it('pages next on a clear leftward swipe', () => {
    const { onNext, onPrev, swipe } = setup()
    swipe([300, 400], [200, 410]) // dx -100, dy 10
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('pages previous on a clear rightward swipe', () => {
    const { onNext, onPrev, swipe } = setup()
    swipe([100, 400], [220, 405])
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).not.toHaveBeenCalled()
  })

  it('ignores a mostly-vertical drag (a scroll)', () => {
    const { onNext, onPrev, swipe } = setup()
    swipe([200, 200], [230, 400]) // dx 30, dy 200 → vertical dominates
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('ignores a short drag below the threshold', () => {
    const { onNext, onPrev, swipe } = setup()
    swipe([200, 200], [160, 205]) // dx -40 < 64
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('ignores mouse pointers (desktop uses the nav bar)', () => {
    const { onNext, swipe } = setup()
    swipe([300, 400], [180, 405], { pointerType: 'mouse' })
    expect(onNext).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const { onNext, swipe } = setup(false)
    swipe([300, 400], [180, 405])
    expect(onNext).not.toHaveBeenCalled()
  })

  it('does not arm on an interactive control (slider/input)', () => {
    const { onNext, result } = (() => {
      const onPrev = vi.fn(), onNext = vi.fn()
      const { result } = renderHook(() => useSectionSwipe({ enabled: true, onPrev, onNext }))
      return { onNext, result }
    })()
    const target = { closest: (sel: string) => (sel.includes('slider') ? {} : null) } as unknown as Element
    result.current.onPointerDown(ev({ clientX: 300, clientY: 400, target }))
    result.current.onPointerUp(ev({ clientX: 180, clientY: 405 }))
    expect(onNext).not.toHaveBeenCalled()
  })
})
