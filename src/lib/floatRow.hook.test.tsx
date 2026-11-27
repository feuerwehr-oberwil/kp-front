// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { type Box, useFloatRowPlacement } from './floatRow'

// The DOM of a phone workspace as far as the hook reads it: the `.app.phone-tools` root, one tile
// row with a tile, and whatever a test adds. jsdom lays nothing out, so every element answers
// `getBoundingClientRect` from `rects` (unset: an empty box, which the hook skips), a tile lifted
// by its row's `--row-lift`.
const rects = new Map<Element, Box>()
let reads = 0
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

/** Run the frames the hook asked for, as the browser does before it paints. */
const paint = () => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(performance.now()) }
/** Let the MutationObserver deliver what the DOM just did (a microtask). */
const settle = () => new Promise<void>((r) => queueMicrotask(r))

const el = (cls: string, parent: Element, r?: Box) => {
  const e = document.createElement('div')
  e.className = cls
  parent.append(e)
  if (r) rects.set(e, r)
  return e
}

let app: HTMLElement
let row: HTMLElement
beforeEach(() => {
  reads = 0
  frames.clear()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    reads++
    const at = rects.get(this) ?? { left: 0, right: 0, top: 0, bottom: 0 }
    // a tile stands where its row's lift carries it, as the browser would lay it out
    const up = parseFloat(this.closest<HTMLElement>('.wb-botleft')?.style.getPropertyValue('--row-lift') ?? '') || 0
    const r = { ...at, top: at.top - up, bottom: at.bottom - up }
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect
  })
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++nextFrame, f); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  app = el('app phone-tools', document.body)
  row = el('wb-botleft', app)
  // a 390px phone: the tile at its floor, 8px in from the left, 52px tall
  el('tile', row, { left: 8, right: 60, top: 600, bottom: 652 })
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.stackLane
  rects.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const lift = () => row.style.getPropertyValue('--row-lift')
/** a dock as wide as the line tool's: under the tile, so the row rises one gap above it */
const wideDock = { left: 30, right: 360, top: 592, bottom: 652 }

describe('useFloatRowPlacement — when the floating row is placed', () => {
  it('places at mount before anything is painted', () => {
    renderHook(() => useFloatRowPlacement(true))
    expect(row.dataset.floatPlaced).toBe('')
    expect(lift()).toBe('0px')
  })

  it('does not measure for DOM that cannot move a row (40 keystrokes in a list elsewhere)', async () => {
    const list = el('verlauf', app)
    renderHook(() => useFloatRowPlacement(true))
    reads = 0
    for (let i = 0; i < 40; i++) {
      el('entry', list)
      await settle()
      paint()
    }
    expect(reads).toBe(0)
  })

  it('places once per frame, however many docks came in it, and before the paint', async () => {
    renderHook(() => useFloatRowPlacement(true))
    const perPass = reads
    reads = 0
    const tools = el('tools', app)
    for (let i = 0; i < 10; i++) {
      el('wb-dock', tools, i === 9 ? wideDock : undefined)
      await settle()
    }
    paint()
    expect(reads).toBe(perPass + 10)
    expect(lift()).toBe(`${652 - 592 + 8}px`)
  })

  it('re-places when the dock changes width with its options (DOM inside the dock)', async () => {
    const dock = el('wb-dock', app, { left: 135, right: 255, top: 592, bottom: 652 })
    renderHook(() => useFloatRowPlacement(true))
    expect(lift()).toBe('0px')
    rects.set(dock, wideDock)
    el('option', dock)
    await settle()
    paint()
    expect(lift()).toBe(`${652 - 592 + 8}px`)
  })

  it('comes back down when the dock goes', async () => {
    const dock = el('wb-dock', app, wideDock)
    renderHook(() => useFloatRowPlacement(true))
    expect(lift()).toBe(`${652 - 592 + 8}px`)
    dock.remove()
    await settle()
    paint()
    expect(lift()).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--stack-lane')).toBe('')
  })

  it('re-places when a detail sheet comes (it moves the FAB and the ✥ ⟳ bar by CSS)', async () => {
    renderHook(() => useFloatRowPlacement(true))
    reads = 0
    const sheet = el('ctx', app)
    await settle()
    paint()
    expect(reads).toBe(1)
    reads = 0
    el('line', sheet)
    await settle()
    paint()
    expect(reads).toBe(0)
  })

  it('yields under a Meldeleiste that comes while it stands lifted', async () => {
    el('wb-dock', app, { left: 30, right: 360, top: 300, bottom: 652 })
    renderHook(() => useFloatRowPlacement(true))
    expect(row.dataset.floatYield).toBeUndefined()
    el('ml', app, { left: 0, right: 390, top: 50, bottom: 260 })
    await settle()
    paint()
    expect(row.dataset.floatYield).toBe('')
  })

  it('re-places when the strip stays but its cap changes (Standort comes under the top bar)', async () => {
    renderHook(() => useFloatRowPlacement(true))
    el('ml', app, { left: 0, right: 390, top: 50, bottom: 260 })
    const share = el('tb-share', app)
    await settle()
    paint()
    reads = 0
    el('standort', share)
    await settle()
    paint()
    expect(reads).toBeGreaterThan(0)
  })

  it('re-places when the strip changes size with no DOM change (Messen\'s panel under a capped strip)', () => {
    let resized = () => {}
    const watched = new Set<Element>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { resized = cb }
      observe(t: Element) { watched.add(t) }
      unobserve(t: Element) { watched.delete(t) }
      disconnect() { watched.clear() }
    })
    // the panel clamped under a tall strip (its top at `--under-alert`)
    const panel = el('wb-dock', app, { left: 30, right: 360, top: 580, bottom: 652 })
    const strip = el('ml', app, { left: 0, right: 390, top: 50, bottom: 500 })
    renderHook(() => useFloatRowPlacement(true))
    expect([...watched]).toEqual([strip])
    expect(lift()).toBe(`${652 - 580 + 8}px`)
    // arming capped the strip; it republished its height and the panel grew under it – no DOM came
    rects.set(strip, { left: 0, right: 390, top: 50, bottom: 240 })
    rects.set(panel, { left: 30, right: 360, top: 572, bottom: 652 })
    reads = 0
    resized()
    paint()
    expect(lift()).toBe(`${652 - 572 + 8}px`)
    expect(reads).toBeGreaterThan(0)
  })

  it('places on resize', () => {
    const dock = el('wb-dock', app, { left: 135, right: 255, top: 592, bottom: 652 })
    renderHook(() => useFloatRowPlacement(true))
    rects.set(dock, wideDock)
    window.dispatchEvent(new Event('resize'))
    paint()
    expect(lift()).toBe(`${652 - 592 + 8}px`)
  })

  it('writes nothing when a pass measures what is already there', async () => {
    const dock = el('wb-dock', app, wideDock)
    renderHook(() => useFloatRowPlacement(true))
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    el('option', dock)
    await settle()
    paint()
    expect(writes).not.toHaveBeenCalled()
  })

  it('takes back what it wrote on unmount and drops a pending frame', async () => {
    el('wb-dock', app, wideDock)
    const { unmount } = renderHook(() => useFloatRowPlacement(true))
    expect(document.documentElement.dataset.stackLane).toBe('')
    el('wb-dock', app)
    await settle()
    unmount()
    reads = 0
    paint()
    expect(reads).toBe(0)
    expect(row.dataset.floatPlaced).toBeUndefined()
    expect(lift()).toBe('')
    expect(document.documentElement.dataset.stackLane).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--stack-lane')).toBe('')
  })
})
