// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef, useImperativeHandle, useState, type Ref } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { stubMatchMedia } from '../test/dom.test-utils'
import { fillTemplate } from '../lib/format'
import { AnwesenheitView } from './AnwesenheitView'
import { appConfig } from '../config/appConfig'
import { applyLocale } from '../config/copy'
import { adoptSessionConfig } from '../lib/deploymentConfig'
import { closePresence, openPresence, setIntervalTime } from '../lib/attendanceIntervals'
import type { LivePerson } from '../lib/usePersonPositions'
import type { AttendanceState, LngLat, Person } from '../types'

/*
 * What ONE presence tap costs the crew list (perf sweep 26.11.2026, finding «anwesenheit-tap»).
 *
 * Every person row draws its Dienstgrad chip, so the RankBadge stand-in below counts row renders,
 * keyed by the rank it was handed – each person carries their own rank key (`r-<id>`), which is
 * how a count names the row.
 */
const rowRenders: string[] = []
vi.mock('./RankBadge', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./RankBadge')>()
  return { ...mod, RankBadge: (p: { rank?: string }) => { rowRenders.push(p.rank ?? '?'); return mod.RankBadge(p) } }
})

afterEach(cleanup)
beforeAll(() => { stubMatchMedia(() => false) })
beforeEach(() => { rowRenders.length = 0 })

const A = appConfig.copy.anwesenheit
const START = '2026-11-27T08:00:00.000Z'
const N = 44
const pad = (i: number) => String(i).padStart(2, '0')
const roster: Person[] = Array.from({ length: N }, (_, i) => ({
  id: `p${pad(i)}`, displayName: `Person ${pad(i)}`, rank: `r-p${pad(i)}`, active: true, updatedAt: 't',
}))
/** a fat Einsatz: 30 anwesend (5 of them im Magazin), 8 gegangen, 6 frei; every fourth has a remark */
const initialAttendance = (): AttendanceState => {
  const out: AttendanceState = {}
  roster.forEach((p, i) => {
    if (i >= 38) return
    let e = openPresence(undefined, START, p.displayName)
    if (i >= 30) e = closePresence(e, '2026-11-27T09:00:00.000Z', p.displayName)
    if (i < 5) e = { ...e, ort: 'station' }
    if (i % 4 === 0) e = { ...e, note: 'Fahrer TLF' }
    out[p.id] = e
  })
  return out
}
const center: LngLat = [7.55, 47.51]

type Over = Partial<Parameters<typeof AnwesenheitView>[0]>
/** the workspace in miniature: attendance as state, writers shaped like useAttendanceActions'
 *  (a spread over the one changed entry), and FRESH closures on every render, as the workspace
 *  hands them. `bump` re-renders with nothing changed – the save / Verlauf / sync commits. */
type HostCtl = { bump: () => void; setOver: (o: Over) => void; setAtt: (f: (cur: AttendanceState) => AttendanceState) => void }
const host = createRef<HostCtl>()
const bump = () => host.current?.bump()
const setOver = (o: Over) => host.current?.setOver(o)
const setAtt = (f: (cur: AttendanceState) => AttendanceState) => host.current?.setAtt(f)
function Host({ initial, ctl }: { initial: Over; ctl: Ref<HostCtl> }) {
  const [attendance, setAttendance] = useState(initialAttendance)
  const [, setTick] = useState(0)
  const [over, setOverState] = useState<Over>(initial)
  useImperativeHandle(ctl, () => ({
    bump: () => setTick((t) => t + 1),
    setAtt: setAttendance,
    setOver: (o) => setOverState((cur) => ({ ...cur, ...o })),
  }), [])
  const now = () => new Date().toISOString()
  return (
    <AnwesenheitView
      people={roster} attendance={attendance} canEdit loading={false} error={false}
      blockedIds={new Set()} truppOfPerson={new Map()}
      onMarkPresent={(p) => setAttendance((cur) => ({ ...cur, [p.id]: openPresence(cur[p.id], now(), p.displayName) }))}
      onMarkLeft={(p) => setAttendance((cur) => ({ ...cur, [p.id]: closePresence(cur[p.id], now(), p.displayName) }))}
      onClear={(p) => setAttendance((cur) => { const next = { ...cur }; delete next[p.id]; return next })}
      onSetOrt={(p) => setAttendance((cur) => ({ ...cur, [p.id]: { ...cur[p.id], ort: cur[p.id].ort === 'station' ? 'scene' : 'station' } }))}
      onSetNote={(id, note) => setAttendance((cur) => ({ ...cur, [id]: { ...cur[id], note } }))}
      onJumpToTrupp={() => {}} onReload={() => {}} onShowOnMap={() => {}}
      incidentCenter={center}
      {...over}
    />
  )
}
/** mounts the list and lets its mount settle (one passive-effect commit), then zeroes the count */
const mount = (over: Over = {}) => {
  render(<Host initial={over} ctl={host} />)
  act(() => { bump() })
  rowRenders.length = 0
}
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`${name}$`) })
const stateWord = (name: string) => row(name).querySelector('.sr-only')?.textContent
/** the rows that rendered since the last reset, as person ids */
const rendered = () => rowRenders.map((r) => r.slice(2))
const reset = () => { rowRenders.length = 0 }

describe('one presence tap renders the tapped row, and no other', () => {
  it('marks one person gegangen: one row (it was all 44)', () => {
    mount()
    act(() => { fireEvent.click(row('Person 10')) })
    expect(rendered()).toEqual(['p10'])
    expect(stateWord('Person 10')).toBe(`${A.statusLeft}: `)
  })

  it('the commits after the tap (save, Verlauf row, sync status) render no row', () => {
    mount()
    act(() => { bump() })
    act(() => { bump() })
    expect(rendered()).toEqual([])
  })

  it('cycles frei → anwesend → gegangen → frei, one row per tap, the state word in its name', () => {
    mount()
    const words: (string | null | undefined)[] = []
    for (let i = 0; i < 3; i++) {
      act(() => { fireEvent.click(row('Person 40')) })
      words.push(stateWord('Person 40'))
    }
    expect(words).toEqual([`${A.statusPresent}: `, `${A.statusLeft}: `, `${A.statusFrei}: `])
    expect(rendered()).toEqual(['p40', 'p40', 'p40'])
  })

  it('a locked row jumps to its Trupp and renders nothing', () => {
    const onJumpToTrupp = vi.fn()
    mount({ blockedIds: new Set(['p10']), truppOfPerson: new Map([['p10', 't1']]), onJumpToTrupp })
    act(() => { fireEvent.click(row('Person 10')) })
    expect(onJumpToTrupp).toHaveBeenCalledWith('t1')
    expect(rendered()).toEqual([])
  })

  it('a write from another device (every entry a fresh object) renders only the row it changed', () => {
    mount()
    act(() => { setAtt((cur) => {
      const remote: AttendanceState = structuredClone(cur)
      remote.p05 = closePresence(remote.p05, '2026-11-27T10:00:00.000Z')
      return remote
    }) })
    expect(rendered()).toEqual(['p05'])
    expect(stateWord('Person 05')).toBe(`${A.statusLeft}: `)
  })

  it('a guest row stays put while somebody else is tapped, and cycles gegangen → anwesend', () => {
    mount()
    act(() => { setAtt((cur) => ({ ...cur, g1: closePresence(openPresence(undefined, START, 'Gast Felix'), '2026-11-27T09:00:00.000Z') })) })
    expect(screen.getByRole('button', { name: /Gast Felix$/ }).textContent).toContain(A.guestBadge)
    reset()
    act(() => { fireEvent.click(row('Person 10')) })
    expect(rendered()).toEqual(['p10'])
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Gast Felix$/ })) })
    expect(stateWord('Gast Felix')).toBe(`${A.statusPresent}: `)
  })
})

/* The memo from the other side (#825's review found a memo that hid a real change): every input
 * that shows on a row renders THAT row, and only it. */
describe('every input a row shows still renders that row, and only that row', () => {
  it('the remark dot', () => {
    mount()
    act(() => { setAtt((cur) => ({ ...cur, p21: { ...cur.p21, note: 'abgelöst 21:40' } })) })
    expect(rendered()).toEqual(['p21'])
    expect(screen.getByRole('button', { name: fillTemplate(A.openBlocksNote, { name: 'Person 21' }) })).toBeTruthy()
  })

  it('a corrected time renders no row – the row carries no time, the Zeiten sheet does', () => {
    mount()
    act(() => { setAtt((cur) => ({ ...cur, p21: setIntervalTime(cur.p21, 0, { from: '2026-11-27T08:10:00.000Z' }) })) })
    expect(rendered()).toEqual([])
  })

  it('the Ort, picked in its menu', async () => {
    mount()
    act(() => { fireEvent.click(screen.getByRole('button', { name: `${fillTemplate(A.ortPick, { name: 'Person 10' })}: ${A.ortScene}` })) })
    reset()
    act(() => { fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(A.ortToStationPick) })) })
    expect(rendered()).toEqual(['p10'])
    expect(screen.getByRole('button', { name: `${fillTemplate(A.ortPick, { name: 'Person 10' })}: ${A.ortStation}` })).toBeTruthy()
  })

  it('the live position: appears, moves, ages – and a rebuilt map with the same fix renders nothing', () => {
    const L = appConfig.copy.livePosition
    const now = Date.parse('2026-11-27T10:00:00.000Z')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const fix: LivePerson = { personId: 'p10', displayName: 'Person 10', coord: [7.56, 47.51], at: now, accuracyM: 5 }
    mount()
    const chip = () => screen.getAllByRole('button', { name: new RegExp(L.tapHint) })
    act(() => { setOver({ livePositions: new Map([['p10', fix]]) }) })
    expect(rendered()).toEqual(['p10'])
    expect(chip()).toHaveLength(1)
    reset()
    act(() => { setOver({ livePositions: new Map([['p10', fix]]) }) })
    expect(rendered()).toEqual([])
    act(() => { setOver({ livePositions: new Map([['p10', { ...fix, coord: [7.55, 47.51] }]]) }) })
    expect(rendered()).toEqual(['p10'])
    expect(chip()[0].getAttribute('aria-label')).toContain(L.atScene)
    reset()
    clock.mockReturnValue(now + 3 * 60_000)
    act(() => { setOver({ livePositions: new Map([['p10', { ...fix, coord: [7.55, 47.51] }]]), incidentCenter: [7.57, 47.51] }) })
    expect(rendered()).toEqual(['p10'])
    expect(chip()[0].getAttribute('aria-label')).toContain(fillTemplate(L.chip, { d: '', n: '3' }).replace(/^ · /, ''))
    clock.mockRestore()
  })

  it('the rank badge, the roster source note, the locked icon', () => {
    mount()
    act(() => { setOver({ people: roster.map((p) => (p.id === 'p03' ? { ...p, rank: 'r-p03b' } : p)) }) })
    expect(rowRenders).toEqual(['r-p03b'])
    reset()
    act(() => { setOver({ people: roster.map((p) => (p.id === 'p03' ? { ...p, rank: 'r-p03b', active: false } : p)) }) })
    expect(rendered()).toEqual(['p03b'])
    expect(row('Person 03').getAttribute('title')).toBe(A.notInDivera)
    reset()
    act(() => { setOver({ blockedIds: new Set(['p11']) }) })
    expect(rendered()).toEqual(['p11'])
    expect(row('Person 11').getAttribute('title')).toBe(A.lockedTitle)
  })

  it('the search and the «Vor Ort» filter narrow at once, re-rendering none of the rows that stay', () => {
    mount()
    act(() => { fireEvent.change(screen.getByPlaceholderText(A.searchPlaceholder), { target: { value: 'Person 17' } }) })
    expect(rendered()).toEqual([])
    expect(screen.getByRole('button', { name: /Person 17$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Person 23$/ })).toBeNull()
    act(() => { fireEvent.change(screen.getByPlaceholderText(A.searchPlaceholder), { target: { value: '' } }) })
    reset()
    act(() => { fireEvent.click(screen.getByRole('button', { name: A.onlyPresent })) })
    expect(rendered()).toEqual([])
    // 30 anwesend, 5 of them im Magazin: «Vor Ort» leaves 25
    expect(screen.queryByRole('button', { name: /Person 02$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Person 31$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Person 07$/ })).toBeTruthy()
  })

  describe('the station config', () => {
    afterAll(() => { adoptSessionConfig({}) })
    it('a rank list that lands renders every row with it', () => {
      mount()
      act(() => { adoptSessionConfig({ roster: { ranks: [{ key: 'r-p03', label: 'Wachtmeister', abbr: 'Wm' }] } }) })
      expect(rendered()).toHaveLength(N)
      expect(row('Person 03').textContent).toContain('Wm')
    })
  })

  describe('the language', () => {
    afterAll(async () => { await applyLocale('de-CH') })
    it('a catalogue that lands renders every row in it', async () => {
      mount()
      await act(async () => { await applyLocale('en') })
      act(() => { bump() })
      expect(rendered()).toHaveLength(N)
      expect(stateWord('Person 40')).toBe(`${appConfig.copy.anwesenheit.statusFrei}: `)
      expect(appConfig.copy.anwesenheit.statusFrei).not.toBe(A.statusFrei)
    })
  })
})
