// @vitest-environment jsdom
// The board's clocks: what ticks every second and what does not (perf sweep 26.11.2026, finding 16).
// The contact, break and Einsatzzeit clocks are leaves on one shared second ticker
// (lib/boardClock); the board and its cards render only when a Trupp's tier, state or sort
// position changes — and then in the same second the old per-second board did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import { useIsPhone } from '../lib/useIsPhone'
import { plainWords } from './truppCardText'
import { adoptSessionConfig, atemschutzDoctrine } from '../lib/deploymentConfig'
import { fmtClock } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import { noteServerTime, resetServerClock, serverNow } from '../lib/serverClock'
import { aktivTrupp, az, druckName, firstBtn, propsFor, registerAtemschutzViewHooks } from './AtemschutzView.setup'
import { applyLocale, getCopy } from '../config/copy'
import s from './Atemschutz.module.css'
import type { Trupp } from '../types'

// the view is the one component on the board that asks useIsPhone: its calls count board renders
vi.mock('../lib/useIsPhone', async (original) => ({ ...await original<typeof import('../lib/useIsPhone')>(), useIsPhone: vi.fn(() => false) }))
// …and every TruppCard / TruppRow (and its RowLine) asks plainWords once: its calls count card renders
vi.mock('./truppCardText', async (original) => {
  const m = await original<typeof import('./truppCardText')>()
  return { ...m, plainWords: vi.fn(m.plainWords) }
})

// …and the board's two change subscriptions are counted while they are open
const openSubs = vi.hoisted(() => ({ config: 0, copy: 0 }))
vi.mock('../lib/deploymentConfig', async (original) => {
  const m = await original<typeof import('../lib/deploymentConfig')>()
  return { ...m, subscribeDeploymentConfig: (l: () => void) => {
    openSubs.config++
    const off = m.subscribeDeploymentConfig(l)
    return () => { openSubs.config--; off() }
  } }
})
vi.mock('../config/copy', async (original) => {
  const m = await original<typeof import('../config/copy')>()
  return { ...m, subscribeCopy: (l: () => void) => {
    openSubs.copy++
    const off = m.subscribeCopy(l)
    return () => { openSubs.copy--; off() }
  } }
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

describe('a doctrine that lands after the board mounted', () => {
  afterEach(() => adoptSessionConfig({}))

  it('turns the Alarmdruck red within a tick, on the card too', () => {
    const line = atemschutzDoctrine().alarmBar
    // 20 bar above the shipped line: no alarm yet
    mountBoard([inside('a', 'Alpha', 30, { lastPressureBar: line + 20 })])
    expect(cardOf('Alpha').classList.contains(s.trowCrit)).toBe(false)
    // the station's config answer arrives late and raises the line above the reading
    adoptSessionConfig({ doctrine: { alarmBar: line + 40 } } as never)
    tick()
    expect(cardOf('Alpha').classList.contains(s.trowCrit)).toBe(true)
  })
})

describe('the board keeps ticking for what reads the clock itself', () => {
  afterEach(() => applyLocale('de-CH'))

  it('ticks while the Trupp form is open, even with no clock running on the board', () => {
    mountBoard([ready('d', 'Delta')])
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(firstBtn(az.newTrupp))
    act(() => { vi.advanceTimersByTime(0) })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it.each([['the tablet grid', false], ['the phone board', true]] as const)('draws the cards in a language catalogue that lands after the board mounted — %s', async (_, phone) => {
    vi.mocked(useIsPhone).mockReturnValue(phone)
    mountBoard([inside('a', 'Alpha', 30)])
    const kontakt = () => cardOf('Alpha').querySelector(`.${s.trowKontakt}`)!.textContent
    const caption = () => cardOf('Alpha').querySelector(`.${s.trowSub}`)!.textContent
    expect(kontakt()).toBe(getCopy().atemschutz.actContact)
    await act(async () => { await applyLocale('en') })
    const en = getCopy().atemschutz
    expect(en.actContact).not.toBe(az.actContact)
    tick()
    expect({ kontakt: kontakt(), caption: caption() }).toEqual({ kontakt: en.actContact, caption: en.sinceContact })
  })
})

/* Thresholds the minute-long equivalence walk does not reach. Each test ticks to the second a
 * value changes and checks it on both sides; each fails if its value leaves its leaf or the
 * board's tick key. */
describe('a threshold further out', () => {
  // the shipped fallback: 50 l/min from a 7 l cylinder, about 7 bar a minute
  const nearLine = (line: number, over: Partial<Trupp> = {}) => inside('a', 'Alpha', 5, {
    entryPressureBar: line + 3, entryTime: ago(10), lastPressureBar: undefined, lastPressureTime: undefined, lowestBar: undefined, readings: [],
    ...over,
  })
  const estimateText = () => [...cardOf('Alpha').querySelectorAll(`.${s.metaLine} > span`)]
    .find((el) => el.textContent?.startsWith(az.estimatedShort))?.querySelector('b')?.textContent
  const note = (line: number) => cardOf('Alpha').querySelector(`.${s.airNote}`)?.textContent === fillTemplate(az.alarmNoteEst, { bar: line })

  it.each([
    ['the Alarmdruck', 'aktiv', () => atemschutzDoctrine().alarmBar],
    ['the lower Rückzug line', 'rueckzug', () => atemschutzDoctrine().alarmBarRueckzug],
  ] as const)('raises the Schätzung note in the second the projection crosses %s', (_, status, lineOf) => {
    const line = lineOf()
    mountBoard([nearLine(line, { status })])
    let before = estimateText()
    expect(note(line)).toBe(false)
    for (let sec = 1; sec <= 60 && !note(line); sec++) {
      before = estimateText()
      tick()
    }
    // the tick before: above the line, no note; this tick: at the line, the note
    expect(Number(before?.replace(/\D/g, ''))).toBeGreaterThan(line)
    expect(Number(estimateText()?.replace(/\D/g, ''))).toBeLessThanOrEqual(line)
    expect(note(line)).toBe(true)
  })

  it('shows the Schätzung on the Tafel\'s Verlauf the second a timed reading makes one possible', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    // no assumed consumption: only two readings give a Schätzung, and the second is 2.4 s ahead
    adoptSessionConfig({ doctrine: { estConsumptionLPerMin: 0 } } as never)
    try {
      const at = new Date(serverNow() + 2400).toISOString()
      mountBoard([inside('a', 'Alpha', 30, {
        entryPressureBar: 300, entryTime: ago(120), lastPressureBar: 280, lastPressureTime: at, lowestBar: 280,
        readings: [{ t: ago(120), bar: 300, kind: 'entry' }, { t: at, bar: 280, kind: 'pressure' }],
      })], { lite: { subtitle: 'Brand Musterstrasse' } })
      fireEvent.click(screen.getByRole('button', { name: az.verlauf }))
      const panelRow = () => document.querySelector(`.${s.zonePanel}`)?.textContent?.includes(az.estimatedShort) ?? false
      tick(2)
      expect(panelRow()).toBe(false)
      tick()
      expect(panelRow()).toBe(true)
    } finally { adoptSessionConfig({}) }
  })

  it('turns a Tafel tab amber in the second its Trupp is due', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mountBoard([inside('a', 'Alpha', INTERVAL_MIN * 60 - 3.4), inside('b', 'Bravo', 30)], { lite: { subtitle: 'Brand Musterstrasse' } })
    const tab = () => [...document.querySelectorAll(`.${s.tab}`)].find((el) => el.querySelector(`.${s.tabName}`)?.textContent === 'Alpha')!
    tick(2)
    expect(tab().classList.contains(s.tabWarn)).toBe(false)
    tick()
    expect(tab().classList.contains(s.tabWarn)).toBe(true)
    expect(tab().querySelector(`.${s.tabClock}`)!.textContent).toContain(fmtClock(INTERVAL_MIN * 60))
    // …and the next, quiet second only its clock moves
    tick()
    expect(tab().querySelector(`.${s.tabClock}`)!.textContent).toContain(fmtClock(INTERVAL_MIN * 60 + 1))
  })

  it('pins a Trupp over the open form in the second it is due, its clock running', () => {
    vi.mocked(useIsPhone).mockReturnValue(true)
    mountBoard([inside('a', 'Alpha', INTERVAL_MIN * 60 - 3.4), ready('d', 'Delta')])
    fireEvent.click(firstBtn(az.newTrupp))
    tick(2)
    expect(document.querySelector(`.${s.pinRow}`)).toBeNull()
    tick()
    expect(document.querySelector(`.${s.pinRow} .${s.pinClock}`)!.textContent).toBe(fmtClock(INTERVAL_MIN * 60))
    tick()
    expect(document.querySelector(`.${s.pinRow} .${s.pinClock}`)!.textContent).toBe(fmtClock(INTERVAL_MIN * 60 + 1))
  })

  it('rolls a Notfall banner\'s pressure age over at the minute, as a fresh drawing does', () => {
    const notfall = inside('a', 'Alpha', 30, { notfallAt: ago(20), lastPressureTime: ago(57.4) })
    const board = mountBoard([notfall])
    const banner = (root: ParentNode) => root.querySelector(`.${s.nfStack}`)!.textContent
    const fresh = () => {
      const f = render(<AtemschutzView {...board.props} />)
      const text = banner(f.container)
      f.unmount()
      return text
    }
    tick(2)
    const at59 = banner(board.container)
    expect(at59).toBe(fresh())
    tick()
    expect(banner(board.container)).not.toBe(at59)
    expect(banner(board.container)).toBe(fresh())
  })

  it('drops the pressure sheet\'s first-reading hint at the 3-minute cutoff, the sheet held open', () => {
    mountBoard([inside('a', 'Alpha', 30, {
      entryTime: ago(3 * 60 - 2.5), lastPressureBar: undefined, lastPressureTime: undefined, lowestBar: undefined, readings: [],
    })])
    fireEvent.click(screen.getByRole('button', { name: druckName }))
    const first = fillTemplate(az.pressureSheetFirst, { bar: aktivTrupp().entryPressureBar })
    tick(2)
    expect(screen.queryByText(first)).not.toBeNull()
    tick()
    expect(screen.queryByText(first)).toBeNull()
    expect(screen.queryByText(az.pressureSheetHint)).not.toBeNull()
  })

  it('drops «Welche Flasche?» and its submit gate at the 10-minute cutoff, the form held open', () => {
    const exitAt = ago(10 * 60 - 2.5)
    mountBoard([{
      ...inside('a', 'Alpha', 30), status: 'raus', exitTime: exitAt, lastPressureBar: 120,
      readings: [{ t: ago(30 * 60), bar: 300, kind: 'entry' }, { t: exitAt, bar: 120, kind: 'exit' }],
    }])
    fireEvent.click(screen.getByRole('button', { name: az.actReenter }))
    const ask = () => screen.queryByText(fillTemplate(az.bottleAsk, { min: '9', bar: '120' }))
    // the form's own submit wears `aria-disabled` (TruppForm: a reason stays explainable)
    const blocked = () => document.querySelector('.ip-btn.primary[aria-disabled]')?.getAttribute('aria-disabled')
    tick(2)
    expect(ask()).not.toBeNull()
    expect(blocked()).toBe('true')
    tick()
    expect(ask()).toBeNull()
    expect(blocked()).toBe('false')
  })
})

describe('a station config that lands after the board mounted', () => {
  afterEach(() => adoptSessionConfig({}))

  it('folds a late contact interval into the tier, the clock caption and the card', () => {
    const d = atemschutzDoctrine()
    // no per-incident interval: the board resolves the station's own on every tick
    const props = propsFor({ trupps: [inside('a', 'Alpha', d.contactIntervalMin * 60 - 30)], truppColors: {} })
    render(<AtemschutzView {...props} />)
    act(() => { vi.advanceTimersByTime(0) })
    expect(cardOf('Alpha').classList.contains(s.trowWarn)).toBe(false)
    adoptSessionConfig({ doctrine: { contactIntervalMin: d.contactIntervalMin - 1 } } as never)
    tick()
    expect(cardOf('Alpha').classList.contains(s.trowWarn)).toBe(true)
  })

  it('names a Trupp\'s equipment by a station list that lands late', () => {
    mountBoard([inside('a', 'Alpha', 30, { equipment: ['wbk-neu'] })])
    const gear = () => cardOf('Alpha').textContent ?? ''
    expect(gear()).not.toContain('Wärmebildkamera neu')
    adoptSessionConfig({ doctrine: { equipment: [{ id: 'wbk-neu', label: 'Wärmebildkamera neu' }] } } as never)
    tick()
    expect(gear()).toContain('Wärmebildkamera neu')
  })
})

/* A board of «Bereit» crews runs no clock, so no tick draws it again: a late config answer or
 * language catalogue reaches it through their own change signals (lib/deploymentConfig ·
 * subscribeDeploymentConfig, config/copy · subscribeCopy). */
describe('a clock-less board when the config or the language lands late', () => {
  afterEach(async () => {
    act(() => { adoptSessionConfig({}) })
    await act(async () => { await applyLocale('de-CH') })
  })

  it('names the equipment by the late station list at once — the board once, the card once', () => {
    mountBoard([{ ...ready('d', 'Delta'), equipment: ['wbk-neu'] }, ready('e', 'Echo')])
    expect(vi.getTimerCount()).toBe(0)
    const gear = () => cardOf('Delta').textContent ?? ''
    expect(gear()).not.toContain('Wärmebildkamera neu')
    resetCounts()
    act(() => { adoptSessionConfig({ doctrine: { equipment: [{ id: 'wbk-neu', label: 'Wärmebildkamera neu' }] } } as never) })
    expect(gear()).toContain('Wärmebildkamera neu')
    // every card reads the board's settings, so each draws once (its body and its RowLine)
    expect({ cards: cardRenders(), board: boardRenders() }).toEqual({ cards: 4, board: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders no card for a config answer that changes nothing on the board', () => {
    mountBoard([ready('d', 'Delta'), ready('e', 'Echo')])
    resetCounts()
    act(() => { adoptSessionConfig({ map: { offlineRadiusM: 900 } } as never) })
    expect({ cards: cardRenders(), board: boardRenders() }).toEqual({ cards: 0, board: 1 })
  })

  it('closes its subscriptions when it unmounts — four boards, as the surface tour mounts them', () => {
    const start = { ...openSubs }
    for (const [phone, lite] of [[false, false], [true, false], [true, true], [false, false]] as const) {
      vi.mocked(useIsPhone).mockReturnValue(phone)
      const board = mountBoard([ready('d', 'Delta')], lite ? { lite: { subtitle: 'Brand Musterstrasse' } } : {})
      expect(openSubs).toEqual({ config: start.config + 1, copy: start.copy + 1 })
      board.unmount()
    }
    expect(openSubs).toEqual(start)
  })

  it('draws the cards in a language catalogue that lands late', async () => {
    mountBoard([ready('d', 'Delta')])
    const enter = () => cardOf('Delta').querySelector(`.${s.trowKontakt}, button`)!.textContent
    const de = enter()
    await act(async () => { await applyLocale('en') })
    expect(enter()).not.toBe(de)
    expect(vi.getTimerCount()).toBe(0)
  })
})
