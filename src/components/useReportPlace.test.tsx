// @vitest-environment jsdom
// The Rapport's kept scroll place (useReportPlace · rapportKept): leaving the Rapport must not
// read the body's scroll position while the next surface mounts – that read forces a layout
// (perf sweep 26.11.2026, finding 13) – and must still keep the place it left at.
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rapportKept, useReportPlace, type RapportKept } from './useReportPlace'

const snapshot = () => ({ optionOverrides: {}, krokiAt: null })

/** A Rapport body whose `scrollTop` reads are counted. */
function body(max = Infinity) {
  const el = document.createElement('div')
  let top = 0
  const counts = { reads: 0 }
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get() { counts.reads++; return top },
    // the browser clamps to the scroll range
    set(v: number) { top = Math.min(v, max) },
  })
  /** The operator scrolls: the position moves, then the browser's scroll event. */
  const scrollTo = (v: number) => { top = v; el.dispatchEvent(new Event('scroll')) }
  return { el, counts, scrollTo, setSilently: (v: number) => { top = v } }
}

function mount(b: ReturnType<typeof body>, kept: RapportKept | null = null) {
  return renderHook(() => useReportPlace('inc-1', { current: b.el }, kept, snapshot))
}

afterEach(() => { rapportKept.forget(); vi.restoreAllMocks() })

describe('useReportPlace · the kept scroll place', () => {
  it('leaving reads no scroll position and keeps the one the last scroll ended on', () => {
    const b = body()
    const { unmount } = mount(b)
    act(() => { b.scrollTo(420) })
    b.counts.reads = 0
    unmount()
    expect(b.counts.reads).toBe(0)
    expect(rapportKept.read('inc-1')?.top).toBe(420)
  })

  it('an exit before any scroll keeps the restored place, not 0', () => {
    const b = body()
    const { unmount } = mount(b, { top: 300, tab: 'werwas', optionOverrides: {}, krokiAt: null })
    unmount()
    expect(rapportKept.read('inc-1')).toMatchObject({ top: 300, tab: 'werwas' })
  })

  it('a Rapport that got shorter keeps the place the restore landed on', () => {
    const b = body(100)
    const { unmount } = mount(b, { top: 300, tab: 'bericht', optionOverrides: {}, krokiAt: null })
    unmount()
    expect(rapportKept.read('inc-1')?.top).toBe(100)
  })

  it('a tab picked by hand keeps its top even before the scroll event', () => {
    const b = body()
    const { result, unmount } = mount(b, { top: 300, tab: 'bericht', optionOverrides: {}, krokiAt: null })
    act(() => { result.current.pickTab('beilagen') })
    unmount()
    expect(rapportKept.read('inc-1')).toMatchObject({ top: 0, tab: 'beilagen' })
  })

  it('a jump to a «noch offen» step keeps where it lands, even before the scroll event', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    const b = body()
    Object.defineProperty(b.el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(b.el, 'clientHeight', { configurable: true, value: 600 })
    const step = document.createElement('section')
    step.dataset.step = 'mittel'
    step.getBoundingClientRect = () => ({ top: 500 }) as DOMRect
    b.el.append(step)
    const { result, unmount } = mount(b)
    act(() => { result.current.jumpToStep('mittel') })
    unmount()
    // the section's top just under the sheet's edge (useReportPlace · flashStep: 12px)
    expect(rapportKept.read('inc-1')).toMatchObject({ top: 488, tab: 'werwas' })
  })

  it('an exit in the middle of a smooth jump keeps where it was, then follows the scroll', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    const b = body()
    Object.defineProperty(b.el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(b.el, 'clientHeight', { configurable: true, value: 600 })
    // a smooth scroll has not moved yet when scrollTo returns
    b.el.scrollTo = () => {}
    const step = document.createElement('section')
    step.dataset.step = 'mittel'
    step.getBoundingClientRect = () => ({ top: 500 }) as DOMRect
    b.el.append(step)
    const first = mount(b, { top: 50, tab: 'bericht', optionOverrides: {}, krokiAt: null })
    act(() => { first.result.current.jumpToStep('mittel') })
    first.unmount()
    expect(rapportKept.read('inc-1')?.top).toBe(50)
    const second = mount(b, { top: 50, tab: 'bericht', optionOverrides: {}, krokiAt: null })
    act(() => { second.result.current.jumpToStep('mittel'); b.scrollTo(300); b.scrollTo(488) })
    second.unmount()
    expect(rapportKept.read('inc-1')?.top).toBe(488)
  })

  it('a forgotten place stays forgotten', () => {
    const b = body()
    const { result, unmount } = mount(b)
    act(() => { b.scrollTo(200) })
    act(() => { result.current.forgetPlace() })
    unmount()
    expect(rapportKept.read('inc-1')).toBeNull()
  })
})
