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
