// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useMobileScrollLock } from './useMobileScrollLock'

function Sheet() {
  useMobileScrollLock(true)
  return <><div data-testid="background" /><div role="dialog"><div data-testid="list" style={{ overflowY: 'auto' }} /><div data-testid="suggestions" style={{ overflowX: 'auto' }} /></div><div role="menu" style={{ overflowY: 'auto' }} /></>
}
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
