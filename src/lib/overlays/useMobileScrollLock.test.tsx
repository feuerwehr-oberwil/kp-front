// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AXIS_SLOP_PX, touchAxis, touchMayScroll, useMobileScrollLock, type ScrollBox } from './useMobileScrollLock'

function Sheet() {
  useMobileScrollLock(true)
  return <><div data-testid="background" /><div role="dialog"><div data-testid="body" style={{ overflowY: 'auto' }}><div data-testid="list" style={{ overflowY: 'auto' }} /><div data-testid="suggestions" style={{ overflowX: 'auto' }} /><div data-testid="phrases" data-swipe-ignore="" style={{ overflowX: 'auto', overflowY: 'hidden' }}><span data-testid="chip">Atemschutz</span></div><p data-testid="text">Ziel</p></div></div><div role="menu" style={{ overflowY: 'auto' }} /></>
}
/** One touch: down at (100,100), then every move as a TOTAL offset from there. Returns which
 *  moves were cancelled. */
function touch(el: Element, ...moves: [number, number][]) {
  const event = (type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  event('touchstart', 100, 100)
  return moves.map(([dx, dy]) => event('touchmove', 100 - dx, 100 - dy))
}
const phoneMedia = () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
function gesture(el: Element, dx: number, dy: number) {
  const event = (type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
    el.dispatchEvent(e)
    return e.defaultPrevented
  }
  event('touchstart', 100, 100)
  return event('touchmove', 100 - dx, 100 - dy)
}
function dimensions(el: Element, values: Record<string, number>) {
  for (const [name, value] of Object.entries(values)) Object.defineProperty(el, name, { configurable: true, value })
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('mobile modal scrolling', () => {
  it('blocks background scrolling and edge chaining while allowing sheet, suggestion and portalled menu scrolling', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    const view = render(<Sheet />)
    const list = view.getByTestId('list'), suggestions = view.getByTestId('suggestions'), menu = view.getByRole('menu')
    dimensions(list, { scrollHeight: 600, clientHeight: 200, scrollTop: 100 })
    dimensions(suggestions, { scrollWidth: 600, clientWidth: 200, scrollLeft: 0 })
    dimensions(menu, { scrollHeight: 400, clientHeight: 100, scrollTop: 0 })
    expect(gesture(view.getByTestId('background'), 0, 30)).toBe(true)
    expect(gesture(list, 0, 30)).toBe(false)
    dimensions(list, { scrollTop: 400 })
    expect(gesture(list, 0, 30)).toBe(true)
    expect(gesture(suggestions, 30, 0)).toBe(false)
    expect(gesture(menu, 0, 30)).toBe(false)
    view.unmount()
    expect(gesture(document.body, 0, 30)).toBe(false)
  })
  it('leaves tablet scrolling alone', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    const view = render(<Sheet />)
    expect(gesture(view.getByTestId('background'), 0, 30)).toBe(false)
  })
  it('installs and removes the touch lock as an open sheet crosses the phone breakpoint', () => {
    let matches = false
    let change: (() => void) | undefined
    const media = { get matches() { return matches }, addEventListener: (_: string, on: () => void) => { change = on }, removeEventListener: () => { change = undefined } }
    vi.stubGlobal('matchMedia', () => media)
    const view = render(<Sheet />)
    const background = view.getByTestId('background')
    expect(gesture(background, 0, 30)).toBe(false)
    act(() => { matches = true; change?.() })
    expect(gesture(background, 0, 30)).toBe(true)
    act(() => { matches = false; change?.() })
    expect(gesture(background, 0, 30)).toBe(false)
  })
})

// ── the decision, without a DOM (10.10.2026) ─────────────────────────────────────────────────
describe('touchAxis · from the total travel since touchstart', () => {
  it('names the dominant axis, a tie as both, and nothing before the finger moved', () => {
    expect(touchAxis(0, 0)).toBeNull()
    expect(touchAxis(5, 1)).toBe('x')
    expect(touchAxis(-1, 5)).toBe('y')
    expect(touchAxis(2, -2)).toBe('both')
  })
})

describe('touchMayScroll', () => {
  const box = (over: Partial<ScrollBox> = {}): ScrollBox => ({ overflowX: 'visible', overflowY: 'visible', top: 0, maxX: 0, maxY: 0, ...over })
  const row = box({ overflowX: 'auto', overflowY: 'hidden', maxX: 400 })
  const bodyAtTop = box({ overflowY: 'auto', maxY: 300, top: 0 })
  const bodyMid = box({ overflowY: 'auto', maxY: 300, top: 120 })
  const at = (axis: 'x' | 'y' | 'both', dy: number, chain: ScrollBox[], over: { ignored?: boolean; inModal?: boolean } = {}) =>
    touchMayScroll({ axis, dy, chain, ignored: false, inModal: true, ...over })

  it('never blocks a touch that started inside [data-swipe-ignore] — even the background', () => {
    expect(at('y', -10, [], { ignored: true, inModal: false })).toBe(true)
  })
  it('blocks everything outside the dialog and its pickers', () => {
    expect(at('both', 3, [bodyMid], { inModal: false })).toBe(false)
  })
  it('lets a sideways touch pan a horizontal scroller, at either end of it', () => {
    expect(at('x', 0, [row, bodyAtTop])).toBe(true)
    expect(at('x', 0, [box({ overflowX: 'auto', maxX: 400 })])).toBe(true)
    // …but not where nothing scrolls sideways
    expect(at('x', 0, [bodyMid])).toBe(false)
  })
  it('keeps the vertical guard: a drag past a list\'s edge is cancelled, inside it is not', () => {
    expect(at('y', -10, [row, bodyAtTop])).toBe(false)   // pulling down at the top
    expect(at('y', 10, [row, bodyAtTop])).toBe(true)     // pushing up into the content
    expect(at('y', -10, [bodyMid])).toBe(true)
    expect(at('y', 10, [box({ overflowY: 'auto', maxY: 300, top: 300 })])).toBe(false)
  })
  it('passes an undecided touch when EITHER axis could move — the row under a 1px-down first move', () => {
    expect(at('both', -1, [row, bodyAtTop])).toBe(true)
    expect(at('both', -1, [bodyAtTop])).toBe(false)
  })
})

describe('mobile modal scrolling · one decision per touch (10.10.2026)', () => {
  it('lets the suggestion row pan when the first move is mostly vertical — the iOS cancel', () => {
    phoneMedia()
    const view = render(<Sheet />)
    dimensions(view.getByTestId('phrases'), { scrollWidth: 600, clientWidth: 200, scrollLeft: 0 })
    dimensions(view.getByTestId('body'), { scrollHeight: 800, clientHeight: 400, scrollTop: 0 })
    // started on a chip inside [data-swipe-ignore]: 1px down / 0 across, then a long sideways pull
    expect(touch(view.getByTestId('chip'), [0, -1], [3, -2], [40, -3], [120, -4])).toEqual([false, false, false, false])
  })

  it('judges an unmarked horizontal scroller on both axes until the slop, then on its axis', () => {
    phoneMedia()
    const view = render(<Sheet />)
    dimensions(view.getByTestId('suggestions'), { scrollWidth: 600, clientWidth: 200, scrollLeft: 0 })
    dimensions(view.getByTestId('body'), { scrollHeight: 800, clientHeight: 400, scrollTop: 0 })
    // a tie and a vertical-ish first move do not kill the sideways pan
    expect(touch(view.getByTestId('suggestions'), [1, -1], [2, -3], [30, -3])).toEqual([false, false, false])
    // a deliberate pull DOWN at the body's top edge is still cancelled once it is clearly vertical
    expect(touch(view.getByTestId('suggestions'), [0, -2], [1, -AXIS_SLOP_PX], [1, -30])).toEqual([false, true, true])
  })

  it('locks the axis once: a touch that went sideways over plain text stays blocked', () => {
    phoneMedia()
    const view = render(<Sheet />)
    dimensions(view.getByTestId('body'), { scrollHeight: 800, clientHeight: 400, scrollTop: 0 })
    expect(touch(view.getByTestId('text'), [AXIS_SLOP_PX + 4, 0], [10, 30])).toEqual([true, true])
  })

  it('keeps the sheet body\'s vertical guard — the rubber band at its top, free in its middle', () => {
    phoneMedia()
    const view = render(<Sheet />)
    const body = view.getByTestId('body')
    dimensions(body, { scrollHeight: 800, clientHeight: 400, scrollTop: 0 })
    expect(touch(view.getByTestId('text'), [0, -1], [0, -20])).toEqual([true, true])
    expect(touch(view.getByTestId('text'), [0, 1], [0, 20])).toEqual([false, false])
    dimensions(body, { scrollTop: 150 })
    expect(touch(view.getByTestId('text'), [0, -1], [0, -20])).toEqual([false, false])
    // and the backdrop stays dead on every move
    expect(touch(view.getByTestId('background'), [0, 1], [0, 20], [5, 40])).toEqual([true, true, true])
  })
})
