// @vitest-environment jsdom
// The board's clocks: what ticks every second and what does not (perf sweep 26.11.2026, finding 16).
// The contact, break and Einsatzzeit clocks are leaves on one shared second ticker
// (lib/boardClock); the board and its cards render only when a Trupp's tier, state or sort
// position changes — and then in the same second the old per-second board did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import { useIsPhone } from '../lib/useIsPhone'
import { plainWords } from './truppCardText'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { fmtClock } from '../lib/atemschutz'
import { noteServerTime, resetServerClock, serverNow } from '../lib/serverClock'
import { aktivTrupp, propsFor, registerAtemschutzViewHooks } from './AtemschutzView.setup'
import s from './Atemschutz.module.css'
import type { Trupp } from '../types'

// the view is the one component on the board that asks useIsPhone: its calls count board renders
vi.mock('../lib/useIsPhone', async (original) => ({ ...await original<typeof import('../lib/useIsPhone')>(), useIsPhone: vi.fn(() => false) }))
// …and every TruppCard / TruppRow (and its RowLine) asks plainWords once: its calls count card renders
vi.mock('./truppCardText', async (original) => {
  const m = await original<typeof import('./truppCardText')>()
  return { ...m, plainWords: vi.fn(m.plainWords) }
})

registerAtemschutzViewHooks()

const INTERVAL_MIN = 5
const GRACE_SEC = 60
/** an ISO stamp `sec` seconds before the DEPLOYMENT's now (serverNow), not the device's */
const ago = (sec: number) => new Date(serverNow() - sec * 1000).toISOString()

const inside = (id: string, name: string, contactAgoSec: number, over: Partial<Trupp> = {}): Trupp => ({
  ...aktivTrupp(), id, name, members: [],
  entryTime: ago(contactAgoSec + 60), lastContactTime: ago(contactAgoSec), readings: [],
  ...over,
})
const ready = (id: string, name: string): Trupp => ({
  id, name, members: [], entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', readings: [],
})

const mountBoard = (trupps: Trupp[], over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => {
  const props = propsFor({ trupps, truppColors: {}, intervalMin: INTERVAL_MIN, graceSec: GRACE_SEC, ...over })
  const view = render(<AtemschutzView {...props} />)
  // the mount's own work (effects, the first subscription) lands before anything is counted
  act(() => { vi.advanceTimersByTime(0) })
  return { ...view, props }
}
const boardRenders = () => vi.mocked(useIsPhone).mock.calls.length
const cardRenders = () => vi.mocked(plainWords).mock.calls.length
const resetCounts = () => { vi.mocked(useIsPhone).mockClear(); vi.mocked(plainWords).mockClear() }
const tick = (n = 1) => { for (let i = 0; i < n; i++) act(() => { vi.advanceTimersByTime(1000) }) }

const cardOf = (name: string) => [...document.querySelectorAll<HTMLElement>(`.${s.trowCard}, .${s.trow}`)]
  .find((el) => el.querySelector(`.${s.trowNameTxt}`)?.textContent === name)!
const clockOf = (name: string) => cardOf(name).querySelector(`.${s.trowClockVal}`)!.textContent
const namesInOrder = () => [...document.querySelectorAll(`.${s.trowNameTxt}`)].map((el) => el.textContent)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  resetServerClock()
  vi.mocked(useIsPhone).mockReturnValue(false)
})

describe('the idle board', () => {
  it('ticks only the clocks: 10 s with 3 Trupps inside and 2 ready render no card and no board', () => {
    mountBoard([
      inside('a', 'Alpha', 60), inside('b', 'Bravo', 90), inside('c', 'Charlie', 120),
      ready('d', 'Delta'), ready('e', 'Echo'),
    ])
    const before = clockOf('Alpha')
    resetCounts()
    tick(10)
    expect({ cards: cardRenders(), board: boardRenders() }).toEqual({ cards: 0, board: 0 })
    // …while every running clock still counts, to the second
    expect(before).toBe(fmtClock(60))
    expect(clockOf('Alpha')).toBe(fmtClock(70))
    expect(clockOf('Charlie')).toBe(fmtClock(130))
  })

  it('runs no timer at all while no clock runs on the board', () => {
    mountBoard([ready('d', 'Delta'), ready('e', 'Echo')])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-renders only the card whose Trupp changed', () => {
    const trupps = [inside('a', 'Alpha', 60), inside('b', 'Bravo', 90), ready('d', 'Delta')]
    const { rerender, props } = mountBoard(trupps)
    resetCounts()
    const kontakt = trupps.map((t) => (t.id === 'b' ? { ...t, lastContactTime: ago(0) } : t))
    rerender(<AtemschutzView {...props} trupps={kontakt} />)
    expect(clockOf('Bravo')).toBe(fmtClock(0))
    // one card: its body and its RowLine
    expect(cardRenders()).toBe(2)
  })

  it('reads the clock again the moment the device wakes', () => {
    mountBoard([inside('a', 'Alpha', 60)])
    // a backgrounded tab: 30 s pass with no timer firing
    vi.setSystemTime(Date.now() + 30_000)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(clockOf('Alpha')).toBe(fmtClock(90))
  })
})

/* The tier and the Kontakt tone change in the second the threshold is crossed — read off the
 * deployment's clock. The device runs 7.3 s BEHIND the server here, so a board that read
 * `Date.now()` would turn 7 seconds late. Each Trupp sits at a half-second phase, so the
 * clock's rounding is part of what is tested. */
describe('a threshold crossing', () => {
  beforeEach(() => { noteServerTime(new Date(Date.now() + 7300).toISOString(), Date.now(), Date.now()) })

  const crossing = (thresholdSec: number) => {
    // at tick k the clock reads round(thresholdSec - 3.4 + k): thresholdSec - 1 at k = 2, the threshold at k = 3
    mountBoard([inside('a', 'Alpha', thresholdSec - 3.4), inside('b', 'Bravo', 30)])
    tick(2)
    expect(clockOf('Alpha')).toBe(fmtClock(thresholdSec - 1))
  }
  const kontaktTile = () => cardOf('Alpha').querySelector(`.${s.trowKontakt}`)!

  it('turns «fällig» (amber card, amber Kontakt) in the second the interval runs out', () => {
    crossing(INTERVAL_MIN * 60)
    expect(cardOf('Alpha').classList.contains(s.trowWarn)).toBe(false)
    expect(kontaktTile().classList.contains(s.kontaktWarn)).toBe(false)
    tick()
    expect(clockOf('Alpha')).toBe(fmtClock(INTERVAL_MIN * 60))
    expect(cardOf('Alpha').classList.contains(s.trowWarn)).toBe(true)
    expect(kontaktTile().classList.contains(s.kontaktWarn)).toBe(true)
    expect(cardOf('Bravo').classList.contains(s.trowWarn)).toBe(false)
  })

  it('turns «überfällig» (red card, red Kontakt) in the second the Nachfrist runs out', () => {
    crossing(INTERVAL_MIN * 60 + GRACE_SEC)
    expect(cardOf('Alpha').classList.contains(s.trowCrit)).toBe(false)
    expect(kontaktTile().classList.contains(s.kontaktCrit)).toBe(false)
    tick()
    expect(clockOf('Alpha')).toBe(fmtClock(INTERVAL_MIN * 60 + GRACE_SEC))
    expect(cardOf('Alpha').classList.contains(s.trowCrit)).toBe(true)
    expect(kontaktTile().classList.contains(s.kontaktCrit)).toBe(true)
  })

  it('re-sorts the phone board in the second one alarm outranks the other', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    const line = atemschutzDoctrine().alarmBar
    // Alpha: 10 bar under its Alarmdruck = urgency 600, and in longer — it wins the tie
    // Bravo: out of contact; its clock reads 600 at tick 10 (the tie) and 601 at tick 11
    mountBoard([
      inside('a', 'Alpha', 30, { lastPressureBar: line - 10, entryTime: ago(3000) }),
      inside('b', 'Bravo', 589.6),
    ])
    tick(10)
    expect(clockOf('Bravo')).toBe(fmtClock(600))
    expect(namesInOrder()).toEqual(['Alpha', 'Bravo'])
    tick()
    expect(namesInOrder()).toEqual(['Bravo', 'Alpha'])
  })
})

describe('the handed-over Tafel (Tafel pur)', () => {
  it('ticks the page clock and the tab clocks without rendering the board', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mountBoard([inside('a', 'Alpha', 60), inside('b', 'Bravo', 90)], { lite: { subtitle: 'Brand Musterstrasse' } })
    const tabClock = () => document.querySelector(`.${s.tab} .${s.tabClock}`)!.textContent
    expect(tabClock()).toBe(fmtClock(60))
    resetCounts()
    tick(5)
    expect(tabClock()).toBe(fmtClock(65))
    // the page shows the longest-silent crew
    expect(clockOf('Bravo')).toBe(fmtClock(95))
    expect({ cards: cardRenders(), board: boardRenders() }).toEqual({ cards: 0, board: 0 })
  })
})

/* The board renders on a tick only when its tick key changes — so at every second it must look
 * exactly like a board drawn fresh at that second. A minute across «fällig», «überfällig» and a
 * re-sort, on the «Dringlichkeit» grid and on the phone board. */
describe('the board between its renders', () => {
  const crew = () => {
    const line = atemschutzDoctrine().alarmBar
    return [
      inside('a', 'Alpha', INTERVAL_MIN * 60 - 20.4),
      inside('b', 'Bravo', INTERVAL_MIN * 60 + GRACE_SEC - 50.7),
      // urgency 420: Delta's overdue clock passes it after ~20 s
      inside('c', 'Charlie', 30, { lastPressureBar: line - 7, entryTime: ago(2000) }),
      inside('d', 'Delta', 7 * 60 - 19.8),
      ready('e', 'Echo'),
    ]
  }
  // the ring a mount draws around the most overdue card, and the ids React generates, are the
  // mount's, not the clock's
  const drawn = (root: HTMLElement) => root.innerHTML.replaceAll(` ${s.cardFlash}`, '').replace(/_r_[0-9a-z]+_/g, '_r_')

  it.each([['the tablet grid', false], ['the phone board', true]] as const)('equals a fresh drawing at every second — %s', (_, phone) => {
    vi.mocked(useIsPhone).mockReturnValue(phone)
    const trupps = crew()
    const board = mountBoard(trupps, { order: 'dringlichkeit' })
    for (let sec = 1; sec <= 60; sec++) {
      tick()
      const fresh = render(<AtemschutzView {...board.props} />)
      expect(drawn(board.container), `second ${sec}`).toBe(drawn(fresh.container))
      fresh.unmount()
    }
  }, 30_000)
})
