// @vitest-environment jsdom
// When a head refits (lib/useHeadFit · useHeadFit): every fit runs the whole ladder of style writes
// and layout reads, so a head refits only when what it measures can have changed – its content,
// its width, the fonts (perf sweep 26.11.2026, finding 14).
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHeadFit } from './useHeadFit'

/** ResizeObserver whose reports the test sends: `report(width)` is the browser's next one. */
let reportSize: (width: number) => void = () => {}
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    reportSize = (width) => this.cb([{
      target: el, contentRect: { width } as DOMRectReadOnly,
      borderBoxSize: [{ inlineSize: width, blockSize: 60 }],
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  disconnect() { reportSize = () => {} }
}

/** `document.fonts` as the page sees it: still loading (until `arrive()`), or already loaded. */
function fonts(status: 'loading' | 'loaded') {
  let arrive = () => {}
  const ready = status === 'loaded' ? Promise.resolve() : new Promise<void>((r) => { arrive = r })
  const face = { status, ready }
  Object.defineProperty(document, 'fonts', { configurable: true, value: face })
  return { arrive: async () => { face.status = 'loaded'; arrive(); await ready } }
}

function head(width = 320) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => width })
  document.body.append(el)
  return { el, setWidth: (w: number) => { width = w } }
}

function mount(el: HTMLElement, key = 'a') {
  const fit = vi.fn()
  const hook = renderHook(({ k }) => useHeadFit({ current: el }, k, fit, true), { initialProps: { k: key } })
  return { fit, ...hook }
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', FakeResizeObserver) })
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'fonts')
  document.body.replaceChildren()
})

describe('useHeadFit · a head fits once per open', () => {
  it('fits once – at mount, before paint – when the fonts are in and the width stands', async () => {
    fonts('loaded')
    const { el } = head()
    const { fit } = mount(el)
    expect(fit).toHaveBeenCalledTimes(1)
    // the fonts' promise and the observer's first report have both come
    await act(async () => { await Promise.resolve(); reportSize(320) })
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('refits when the fonts arrive after the first fit', async () => {
    const face = fonts('loading')
    const { el } = head()
    const { fit } = mount(el)
    await act(async () => { reportSize(320) })
    expect(fit).toHaveBeenCalledTimes(1)
    await act(async () => { await face.arrive() })
    expect(fit).toHaveBeenCalledTimes(2)
  })

  it('refits on a real width change, not on a height change', async () => {
    fonts('loaded')
    const h = head()
    const { fit } = mount(h.el)
    await act(async () => { reportSize(320) })
    h.setWidth(280)
    act(() => { reportSize(280) })
    expect(fit).toHaveBeenCalledTimes(2)
    // the ladder's second row makes the head taller: same width, no refit
    act(() => { reportSize(280) })
    expect(fit).toHaveBeenCalledTimes(2)
  })

  it('refits on a content change – a new key, or a chip coming into the head', async () => {
    fonts('loaded')
    const { el } = head()
    const { fit, rerender } = mount(el)
    rerender({ k: 'b' })
    expect(fit).toHaveBeenCalledTimes(2)
    await act(async () => {
      el.append(document.createElement('span'))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fit).toHaveBeenCalledTimes(3)
  })
})
