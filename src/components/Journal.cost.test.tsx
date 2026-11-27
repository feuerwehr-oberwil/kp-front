// @vitest-environment jsdom
// What opening and holding the Verlauf open costs, as counts (performance sweep 26.11.2026): the
// rows the first page mounts, the layout passes of the Pendenzen box, and the rows a new remote
// row re-renders. jsdom has no IntersectionObserver, no ResizeObserver and no layout, so this
// file brings small stand-ins for all three – the browser's paging and fit only run with them.
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Journal } from './Journal'
import { fatIncident, FAT_PRESETS } from '../lib/fatIncident'
import { deriveReminders, type OpenReminder } from '../lib/reminders'
import { liveTargets, rowGlyph } from '../lib/verlauf'
import type { TimelineEvent } from '../types'

// rowGlyph runs once per JournalRow render: it is the row counter
vi.mock('../lib/verlauf', async (importOriginal) => {
  const m = await importOriginal<typeof import('../lib/verlauf')>()
  return { ...m, rowGlyph: vi.fn(m.rowGlyph) }
})

/** the `real` fat incident's Verlauf (316 rows), newest first as the store displays it */
const FAT = fatIncident(FAT_PRESETS.real).journal.slice().reverse()
const LIVE = liveTargets([], [], { pages: [] } as never)

// ── IntersectionObserver: the tail sentinel is «in view» only when the test scrolls to it ──
const observers = new Set<{ cb: IntersectionObserverCallback; els: Set<Element> }>()
class FakeIO {
  private me: { cb: IntersectionObserverCallback; els: Set<Element> }
  constructor(cb: IntersectionObserverCallback) { this.me = { cb, els: new Set() }; observers.add(this.me) }
  observe(el: Element) { this.me.els.add(el) }
  unobserve(el: Element) { this.me.els.delete(el) }
  disconnect() { observers.delete(this.me) }
  takeRecords() { return [] }
}
/** the operator scrolls the list to its end: every watched sentinel comes into view */
const scrollToEnd = () => act(() => {
  for (const o of [...observers]) {
    const entries = [...o.els].map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry)
    if (entries.length) o.cb(entries, {} as IntersectionObserver)
  }
})

const mountedRows = () => document.querySelectorAll('.history-list [data-ev]').length
const mountedIds = () => [...document.querySelectorAll<HTMLElement>('.history-list [data-ev]')].map((el) => el.dataset.ev)

beforeEach(() => { vi.stubGlobal('IntersectionObserver', FakeIO) })
afterEach(() => { cleanup(); observers.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

const props = (over: Partial<React.ComponentProps<typeof Journal>> = {}): React.ComponentProps<typeof Journal> => ({
  events: FAT, plans: [], live: LIVE, onSelect: () => {}, onClose: () => {}, ...over,
})

describe('Journal · the first page', () => {
  it('opening the Verlauf of the busiest Einsatz mounts one screenful, not 150 rows', () => {
    render(<StrictMode><Journal {...props()} /></StrictMode>)
    expect(mountedRows()).toBeLessThanOrEqual(40)
    expect(mountedRows()).toBeGreaterThanOrEqual(30) // a tablet drawer shows 15–25
  })

  it('scrolling to the end still loads every row, in order', () => {
    // the whole list: what the drawer mounts where nothing pages it (no observer)
    vi.stubGlobal('IntersectionObserver', undefined)
    const whole = render(<Journal {...props()} />)
    const all = mountedIds()
    whole.unmount()
    vi.stubGlobal('IntersectionObserver', FakeIO)
    render(<StrictMode><Journal {...props()} /></StrictMode>)
    for (let i = 0; i < 20 && mountedRows() < all.length; i++) scrollToEnd()
    expect(all.length).toBeGreaterThan(250)
    expect(mountedIds()).toEqual(all)
  })
})

describe('Journal · a jump reveals a row the first page does not hold', () => {
  const flashed = (id: string) => document.querySelector(`[data-ev="${id}"]`)?.classList.contains('jr-flash') ?? false
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }) })

  it('the strip lands on the OLDEST row', () => {
    render(<StrictMode><Journal {...props()} /></StrictMode>)
    const oldest = FAT[FAT.length - 1].id
    expect(document.querySelector(`[data-ev="${oldest}"]`)).toBeNull()
    // jsdom lays nothing out: the strip is 0 px wide, so x = 0 is its first moment
    fireEvent.pointerDown(document.querySelector('.jr-strip')!, { clientX: 0 })
    expect(flashed(oldest)).toBe(true)
  })

  it('«im Verlauf» from the Wiedergabe lands on a row in the middle', () => {
    const middle = FAT[Math.floor(FAT.length / 2)].id
    render(<StrictMode><Journal {...props({ landOn: { id: middle, nonce: 1 } })} /></StrictMode>)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(flashed(middle)).toBe(true)
  })

  it('a Meldung\'s «zum Eintrag» lands on the Pendenz it answers, at the very end', () => {
    const first = Date.parse(FAT[FAT.length - 1].at!) - 60_000
    const last = Date.parse(FAT[0].at!) + 60_000
    const raised: TimelineEvent = { id: 'p-old', t: '', at: new Date(first).toISOString(), text: 'Wasserbezug klären', icon: 'type', kind: 'journal', reminder: { op: 'created', id: 'p-old' } }
    const note: TimelineEvent = { id: 'n-new', t: '', at: new Date(last).toISOString(), text: 'Hydrant gefunden', icon: 'note', kind: 'journal', reminder: { op: 'note', id: 'p-old' } }
    render(<StrictMode><Journal {...props({ events: [note, ...FAT, raised] })} /></StrictMode>)
    fireEvent.click(document.querySelector('[data-ev="n-new"] .jr-note-on')!)
    expect(flashed('p-old')).toBe(true)
  })
})

describe('Journal · a page boundary', () => {
  // two days, two rows a minute: the first page ends between the two rows of one minute
  const day1 = Date.parse('2026-11-20T20:00:00Z')
  const day2 = Date.parse('2026-11-21T08:00:00Z')
  const pair = (base: number, n: number): TimelineEvent[] => Array.from({ length: n }, (_, i) => ({
    id: `${base}-${i}`, t: '', at: new Date(base - Math.floor(i / 2) * 60_000).toISOString(), text: `Zeile ${i} von ${base}`, icon: 'note', kind: 'journal',
  }))
  const rows = [...pair(day2, 25), ...pair(day1, 41)]

  it('keeps one separator per day and the «same minute» mark across the boundary', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const whole = render(<Journal {...props({ events: rows })} />)
    const marks = () => [...document.querySelectorAll('.history-list [data-ev] .t')].map((t) => t.hasAttribute('data-same'))
    const want = marks()
    whole.unmount()
    vi.stubGlobal('IntersectionObserver', FakeIO)
    render(<StrictMode><Journal {...props({ events: rows })} /></StrictMode>)
    const firstPage = mountedRows()
    expect(firstPage).toBeLessThan(rows.length)
    expect(marks()).toEqual(want.slice(0, firstPage))
    for (let i = 0; i < 5 && mountedRows() < rows.length; i++) scrollToEnd()
    expect(document.querySelectorAll('.jr-day-sep')).toHaveLength(2)
    expect(marks()).toEqual(want)
  })
})

describe('Journal · the Pendenzen box fits once per change', () => {
  // ── a layout for the box: a 30 px head, rows of 50 px, a CSS cap of half the drawer (600 px),
  // a 24 px foot band. The box's height follows its inline cut, as a browser's does.
  const HEAD = 30, FOOT = 24
  let drawer = 600
  const rowHeight = new Map<string, number>() // by the row's text
  const rowsOf = (box: Element) => [...box.querySelectorAll<HTMLElement>('.jr-pinned-row')]
  const heightOf = (row: Element) => rowHeight.get(row.querySelector('.jr-pinned-text')?.textContent ?? '') ?? 50
  const content = (box: Element) => HEAD + rowsOf(box).reduce((sum, r) => sum + heightOf(r), 0)
  const boxHeight = (box: HTMLElement) => {
    const cut = parseFloat(box.style.maxHeight)
    return Math.min(drawer / 2, Number.isFinite(cut) ? cut : Infinity, content(box))
  }
  const heightModel = (el: Element): number => {
    if (el.classList.contains('jr-pinned')) return boxHeight(el as HTMLElement)
    if (el.classList.contains('jr-pinned-row')) return heightOf(el)
    if (el.classList.contains('jr-pinned-foot')) return FOOT
    if (el.classList.contains('journal-drawer')) return drawer
    return 0
  }
  /** layout passes of the fit: it is the one reader of the box's own rect */
  let boxReads = 0

  // ── ResizeObserver: each frame it reports the observed boxes whose size changed (and every box
  // on its first frame), the way a browser does after layout
  const ros = new Set<FakeRO>()
  class FakeRO {
    private seen = new Map<Element, number | undefined>()
    constructor(private cb: ResizeObserverCallback) { ros.add(this) }
    observe(el: Element) { if (!this.seen.has(el)) this.seen.set(el, undefined) }
    unobserve(el: Element) { this.seen.delete(el) }
    disconnect() { this.seen.clear() }
    deliver() {
      const entries: ResizeObserverEntry[] = []
      for (const [target, was] of this.seen) {
        const h = heightModel(target)
        if (h === was) continue
        this.seen.set(target, h)
        entries.push({ target, contentRect: { height: h, width: 400 }, borderBoxSize: [{ blockSize: h, inlineSize: 400 }] } as unknown as ResizeObserverEntry)
      }
      if (entries.length) this.cb(entries, this as unknown as ResizeObserver)
    }
  }
  /** one frame: the mutation reports (microtasks), the animation callbacks, then layout and the
   *  resize reports */
  const frame = async () => {
    await act(async () => { vi.advanceTimersByTime(16) })
    await act(async () => { for (const ro of [...ros]) ro.deliver() })
  }
  const settle = async () => { for (let i = 0; i < 12; i++) await frame() }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    vi.stubGlobal('ResizeObserver', FakeRO)
    boxReads = 0
    drawer = 600
    rowHeight.clear()
    const real = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const at = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}) })
      if (this.classList.contains('jr-pinned')) { boxReads++; return at(0, heightModel(this)) }
      const box = this.closest<HTMLElement>('.jr-pinned')
      if (box && this.classList.contains('jr-pinned-row')) {
        const rows = rowsOf(box)
        const top = HEAD + rows.slice(0, rows.indexOf(this as HTMLElement)).reduce((sum, r) => sum + heightOf(r), 0)
        return at(top - box.scrollTop, heightOf(this))
      }
      if (box && this.classList.contains('jr-pinned-foot')) return at(boxHeight(box) - FOOT, FOOT)
      return real.call(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return heightModel(this) })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('jr-pinned') ? heightModel(this) : 0 })
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return this.classList.contains('jr-pinned') ? content(this) : 0 })
  })
  afterEach(() => { ros.clear() })

  const open = (n: number): OpenReminder[] => Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, rowId: `row-p${i}`, text: `Pendenz ${i}`, createdAt: new Date(1_000_000 + i * 60_000).toISOString(), notes: [],
  }))
  const box = () => document.querySelector<HTMLElement>('.jr-pinned')!

  it('opening fits the box once, and cuts it at the last whole row', async () => {
    render(<StrictMode><Journal {...props({ openReminders: open(10) })} /></StrictMode>)
    await settle()
    expect(boxReads).toBe(1)
    // the band stands where the fifth row begins: 30 head + 4 × 50 rows + 24 band
    expect(box().style.maxHeight).toBe(`${HEAD + 4 * 50 + FOOT}px`)
    // the «n weitere» band counts what lies below the fold
    expect(box().dataset.more).toBe('true')
    expect(box().querySelector('.jr-pinned-foot')?.textContent).toBe('6 weitere')
  })

  it('a Pendenz added or ticked off elsewhere re-fits once; a row that re-wraps re-fits once', async () => {
    const { rerender } = render(<StrictMode><Journal {...props({ openReminders: open(10) })} /></StrictMode>)
    await settle()
    boxReads = 0
    rerender(<StrictMode><Journal {...props({ openReminders: open(11) })} /></StrictMode>)
    await settle()
    expect(boxReads).toBe(1)
    boxReads = 0
    rerender(<StrictMode><Journal {...props({ openReminders: open(9) })} /></StrictMode>)
    await settle()
    expect(boxReads).toBe(1)
    // late fonts: the first row wraps onto a second line
    boxReads = 0
    rowHeight.set('Pendenz 0', 80)
    await settle()
    expect(boxReads).toBe(1)
    expect(box().style.maxHeight).toBe(`${HEAD + 80 + 3 * 50 + FOOT}px`)
  })

  it('a drawer resize that lands in the frame of the cut\'s own echo still re-fits', async () => {
    render(<StrictMode><Journal {...props({ openReminders: open(10) })} /></StrictMode>)
    await settle()
    // a row re-wraps: reported, and the fit of the next frame moves the cut…
    rowHeight.set('Pendenz 0', 80)
    await act(async () => { for (const ro of [...ros]) ro.deliver() })
    await act(async () => { vi.advanceTimersByTime(16) })
    expect(box().style.maxHeight).toBe(`${HEAD + 80 + 3 * 50 + FOOT}px`)
    // …and in that same frame the drawer shrinks (a keyboard, a rotation): cap 250
    drawer = 500
    await settle()
    expect(box().style.maxHeight).toBe(`${HEAD + 80 + 2 * 50 + FOOT}px`)
  })

  it('a frame where nothing changed size does not fit again', async () => {
    render(<StrictMode><Journal {...props({ openReminders: open(10) })} /></StrictMode>)
    await settle()
    boxReads = 0
    await settle()
    expect(boxReads).toBe(0)
  })
})
