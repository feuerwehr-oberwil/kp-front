// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { laneOverSheet, openSheetTop, useToastLane } from './toastLane'

/* 30.09.2026, owner («slightly odd positioning of the toasts»): a modal bottom sheet no longer
 * flips the phone's toasts to the top of the page — the lane stands one --float-gap above the
 * sheet, and goes to the top of the screen only when no pill fits above it. */
const geo = { layoutHeight: 664, ceiling: 10, pill: 52, gap: 8 }

describe('laneOverSheet', () => {
  it('keeps the bars lane without a sheet', () => {
    expect(laneOverSheet(null, geo)).toEqual({ mode: 'bars' })
  })
  it('stands one gap above the sheet\'s top edge', () => {
    // «Seite wählen»: its top at 388 → the pill's foot 8px above it = 284px over the layout foot
    expect(laneOverSheet(388, geo)).toEqual({ mode: 'sheet', bottom: 284 })
  })
  it('goes to the top of the screen when a pill no longer fits above the sheet', () => {
    expect(laneOverSheet(70, geo)).toEqual({ mode: 'sheet', bottom: 602 }) // 70 − 8 − 52 = 10: fits exactly
    expect(laneOverSheet(69, geo)).toEqual({ mode: 'top' })
    expect(laneOverSheet(24, geo)).toEqual({ mode: 'top' })
  })
})

/* CodeRabbit on #245: a sheet lifted onto a VirtualKeyboard (overlaysContent resizes neither
 * viewport) is still a sheet on the foot, and a pan alone (a viewport SCROLL, no resize) re-measures. */
function sheetAt(top: number, bottom: number) {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  el.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top, toJSON: () => ({}) })
  document.body.append(el)
  return el
}
class FakeViewport extends EventTarget {
  constructor(public height: number, public offsetTop = 0, public scale = 1) { super() }
}
afterEach(() => {
  vi.useRealTimers(); document.body.replaceChildren()
  delete (navigator as { virtualKeyboard?: unknown }).virtualKeyboard
})

describe('openSheetTop', () => {
  it('finds a sheet standing on the VirtualKeyboard\'s top edge', () => {
    window.innerHeight = 800
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: new FakeViewport(800) })
    sheetAt(300, 500)
    expect(openSheetTop()).toBeNull()
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: Object.assign(new EventTarget(), { overlaysContent: true, boundingRect: { height: 300 } }) })
    expect(openSheetTop()).toBe(300)
  })
})

describe('useToastLane', () => {
  it('re-measures on a viewport scroll (a pan moves the sheet without resizing it)', () => {
    vi.useFakeTimers()
    window.innerHeight = 800
    const vv = new FakeViewport(500, 0)
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    const host = document.createElement('div')
    document.body.append(host)
    const sheet = sheetAt(700, 800)
    renderHook(() => useToastLane({ current: host }, true))
    act(() => { vi.advanceTimersByTime(50) })
    expect(host.getAttribute('data-lane')).toBe('sheet')
    expect(host.style.getPropertyValue('--msg-sheet-bottom')).toBe('108px')
    // iOS pans by 200: the sheet now stands on the band's foot at 700, same size
    sheet.getBoundingClientRect = () => ({ top: 500, bottom: 700, left: 0, right: 390, width: 390, height: 200, x: 0, y: 500, toJSON: () => ({}) })
    vv.offsetTop = 200
    act(() => { vv.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(50) })
    expect(host.style.getPropertyValue('--msg-sheet-bottom')).toBe('308px')
  })
})
