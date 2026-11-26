import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { Trupp } from '../../types'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { createUndoTimeline } from '../undoTimeline'
import { resetOwnContacts } from '../contactEcho'
import { truppActionCore } from './core'
import { truppClockActions } from './clock'
import { truppLogName } from '../atemschutz'

// The clock family on its own: the safety rules (Eintritt, Rückzug, Fortsetzen, Raus, Kontakt,
// Notfall) built from the Trupps, the Verlauf and the ↶ timeline ALONE — no map, no plan, no hose.
// The full behaviour through useTruppActions is covered in lib/useTruppActions.test.ts.

const ui = vi.hoisted(() => ({ toasts: [] as string[] }))
// whether this page is the handed-over Atemschutz board (lib/linkMode · onAtemschutzLink)
const page = vi.hoisted(() => ({ link: false }))
vi.mock('../linkMode', async (importOriginal) => ({
  ...await importOriginal<typeof import('../linkMode')>(),
  onAtemschutzLink: () => page.link,
}))
vi.mock('../ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ui')>(),
  toast: (text: string) => { ui.toasts.push(text); return 0 },
  undoToast: (text: string) => { ui.toasts.push(text); return 0 },
}))

const T0 = Date.parse('2026-07-06T10:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const tick = (min: number) => vi.setSystemTime(T0 + min * 60_000)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  tick(0)
  resetOwnContacts()
  ui.toasts.length = 0
})
afterEach(() => { vi.useRealTimers() })

const trupp = (over: Partial<Trupp> = {}): Trupp => ({
  id: 'T1', name: 'Keller Anna', entryPressureBar: 300, entryTime: '', lastContactTime: '',
  status: 'angemeldet', readings: [], ...over,
})

/** the newest row of a Trupp's own log */
const last = (t: Trupp) => t.readings?.[t.readings.length - 1]

/** The clock family over a plain Trupp list. `act()` rebuilds it on the CURRENT list, the way each
 *  render of IncidentWorkspace does; calling one built object twice is two taps in ONE frame. */
function clockBoard(trupps: Trupp[]) {
  const state = { trupps }
  const rows: { icon: string; text: string }[] = []
  const events: string[] = []
  const timeline = createUndoTimeline()
  const act = () => {
    const deps = {
      trupps: state.trupps,
      setTrupps: (a: SetStateAction<Trupp[]>) => { state.trupps = typeof a === 'function' ? a(state.trupps) : a },
      log: (icon: string, text: string) => { rows.push({ icon, text }) },
      emit: (op: string) => { events.push(op) },
      undoTimeline: timeline,
      liveTrupps: () => state.trupps,
    }
    return truppClockActions({ ...deps, ...truppActionCore(deps) })
  }
  const t = () => state.trupps[0]
  return { act, state, rows, events, timeline, t }
}

describe('truppClockActions — the contact clock', () => {
  it('Eintritt starts it, Rückzug and Fortsetzen reset it, Raus stops without touching it', () => {
    const b = clockBoard([trupp()])
    b.act().setTruppStatus('T1', 'aktiv')
    expect(b.t()).toMatchObject({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0) })

    tick(7)
    b.act().setTruppStatus('T1', 'rueckzug')
    expect(b.t()).toMatchObject({ status: 'rueckzug', entryTime: at(0), lastContactTime: at(7) })

    tick(9)
    b.act().setTruppStatus('T1', 'aktiv') // Fortsetzen: back in, NOT a second Eintritt
    expect(b.t()).toMatchObject({ status: 'aktiv', entryTime: at(0), lastContactTime: at(9) })

    tick(20)
    b.act().setTruppStatus('T1', 'raus')
    expect(b.t()).toMatchObject({ status: 'raus', exitTime: at(20), lastContactTime: at(9) })
    expect(b.t().readings?.map((r) => [r.kind, r.t])).toEqual([
      ['entry', at(0)], ['rueckzug', at(7)], ['resume', at(9)], ['exit', at(20)],
    ])
    expect(b.events).toEqual(['atemschutz.status', 'atemschutz.status', 'atemschutz.status', 'atemschutz.status'])
  })

  it('records a transition once: none into the state it is in, one for a double tap in one frame', () => {
    const b = clockBoard([trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0) })])
    b.act().setTruppStatus('T1', 'aktiv')
    expect(b.rows).toEqual([])

    tick(5)
    const frame = b.act() // both taps see the Trupp as this render does
    frame.setTruppStatus('T1', 'raus')
    frame.setTruppStatus('T1', 'raus')
    expect(b.t().readings?.filter((r) => r.kind === 'exit')).toHaveLength(1)
    expect(b.rows).toHaveLength(1)
  })

  it('takes a Kontakt back to the clock it replaced, and redoes it with the ORIGINAL stamp', () => {
    const b = clockBoard([trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0), lastPressureBar: 240 })])
    tick(6)
    b.act().recordContact('T1')
    expect(b.t()).toMatchObject({ lastContactTime: at(6) })
    expect(last(b.t())).toEqual({ t: at(6), bar: 240, kind: 'contact' })

    tick(8)
    b.timeline.undo()
    expect(b.t()).toMatchObject({ lastContactTime: at(0), readings: [] })
    b.timeline.redo()
    // a redo never buys the crew fresh minutes: the clock says 6, not 8
    expect(b.t()).toMatchObject({ lastContactTime: at(6) })
  })

  it('a Druck at the Alarmdruck is ONE alarm reading and resets the clock like a Kontakt', () => {
    const alarmBar = appConfig.atemschutz.alarmBar
    const b = clockBoard([trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0), lastPressureBar: alarmBar + 40,
      readings: [{ t: at(0), bar: 300, kind: 'entry' }] })])
    tick(12)
    b.act().recordPressure('T1', alarmBar)
    expect(b.t()).toMatchObject({ lastContactTime: at(12), lastPressureBar: alarmBar, lowestBar: alarmBar })
    expect(last(b.t())).toMatchObject({ kind: 'alarm', bar: alarmBar })
    expect(b.rows.map((r) => r.icon)).toEqual(['warn'])
  })
})

// owner pick UX journeys M·12 (25.11.2026): a Kontakt logged on the Atemschutz-Link says so in the
// record, and the tablet's Kontakt tile reads it (lib/atemschutz · contactViaLink)
describe('truppClockActions — where a Kontakt was logged', () => {
  afterEach(() => { page.link = false })
  it('stamps the link\'s Kontakt, Druck and Rückzug rows, and nothing the app writes', () => {
    const b = clockBoard([trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0), readings: [{ t: at(0), bar: 300, kind: 'entry' }] })])
    tick(5); b.act().recordContact('T1')
    expect(last(b.t())).not.toHaveProperty('via')
    page.link = true
    tick(6); b.act().recordContact('T1')
    expect(last(b.t())).toMatchObject({ kind: 'contact', via: 'link' })
    tick(7); b.act().recordPressure('T1', 250)
    expect(last(b.t())).toMatchObject({ kind: 'pressure', via: 'link' })
    tick(8); b.act().setTruppStatus('T1', 'rueckzug')
    expect(last(b.t())).toMatchObject({ kind: 'rueckzug', via: 'link' })
  })
})

/* owner pick UX journeys B2·18 (25.11.2026): «Eingangsdruck 180 bar» answers a question, so it is
 * checked against the Trupp as it stands when the answer comes – and never switched silently. */
describe('truppClockActions — the Eingangsdruck asked for', () => {
  const inside = () => trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0), readings: [{ t: at(0), bar: 300, kind: 'entry' }] })
  const tooLate = (bar: number) => fillTemplate(appConfig.copy.atemschutz.earlyLowTooLate, { bar, edit: appConfig.copy.edit })

  it('replaces the Eingangsdruck while it still may', () => {
    const b = clockBoard([inside()])
    tick(1); b.act().recordPressure('T1', 180, { as: 'entry' })
    expect(b.t().entryPressureBar).toBe(180)
    expect(ui.toasts).toEqual([])
  })

  it('an answer after the window is a Druckmeldung, and the board says so', () => {
    const b = clockBoard([inside()])
    tick(2); const asked = b.act()
    tick(4); asked.recordPressure('T1', 180, { as: 'entry' })
    expect(b.t()).toMatchObject({ entryPressureBar: 300, lastPressureBar: 180 })
    expect(last(b.t())).toMatchObject({ kind: 'pressure', bar: 180 })
    expect(ui.toasts).toEqual([tooLate(180)])
  })

  it('never overwrites an Eingangsdruck measured while the question stood', () => {
    const b = clockBoard([inside()])
    tick(1); const asked = b.act()
    b.act().recordPressure('T1', 280) // the first Druck from another hand: the measured baseline
    asked.recordPressure('T1', 180, { as: 'entry' })
    expect(b.t().entryPressureBar).toBe(280)
    expect(last(b.t())).toMatchObject({ kind: 'pressure', bar: 180 })
    expect(ui.toasts).toEqual([tooLate(180)])
  })

  // CodeRabbit r4701810325 + r4702782444: `liveTrupps` is the last render; React applies queued
  // updaters later – and the notice and the Verlauf say what the updater applied, not the guess
  it('never overwrites an Eingangsdruck a merged update measured before the next render', async () => {
    const b = clockBoard([inside()])
    const queue: ((ts: Trupp[]) => Trupp[])[] = []
    const rendered = b.state.trupps
    const deps = {
      trupps: rendered,
      setTrupps: (a: SetStateAction<Trupp[]>) => { queue.push(typeof a === 'function' ? a : () => a) },
      log: (icon: string, text: string) => { b.rows.push({ icon, text }) },
      emit: () => {},
      undoTimeline: b.timeline,
      liveTrupps: () => rendered,
    }
    const batched = truppClockActions({ ...deps, ...truppActionCore(deps) })
    tick(1)
    // the merge of another device's first Druck lands in the queue first: the measured baseline
    const measured = clockBoard([inside()])
    measured.act().recordPressure('T1', 280)
    queue.push(() => measured.state.trupps)
    batched.recordPressure('T1', 180, { as: 'entry' })
    expect(b.rows).toEqual([]) // nothing said before the updater has decided
    b.state.trupps = queue.reduce((ts, up) => up(ts), rendered)
    await Promise.resolve()
    expect(b.t().entryPressureBar).toBe(280)
    expect(last(b.t())).toMatchObject({ kind: 'pressure', bar: 180 })
    expect(ui.toasts).toEqual([tooLate(180)])
    expect(b.rows).toEqual([{ icon: 'drop', text: fillTemplate(appConfig.copy.atemschutz.logPressure, { name: truppLogName(inside()), bar: 180 }) }])
  })
})

describe('truppClockActions — the Notfall', () => {
  it('is raised only on a crew inside, and «Notfall beendet» clears it with an end reading', () => {
    const b = clockBoard([trupp()])
    b.act().triggerNotfall('T1') // angemeldet: nobody inside to rescue
    expect(b.t().notfallAt).toBeUndefined()

    b.act().setTruppStatus('T1', 'aktiv')
    tick(3)
    b.act().triggerNotfall('T1')
    expect(b.t().notfallAt).toBe(at(3))

    tick(10)
    b.act().endNotfall('T1')
    expect(b.t().notfallAt).toBeUndefined()
    expect(b.t().readings?.map((r) => r.kind)).toEqual(['entry', 'notfall', 'notfallEnde'])
    expect(b.events).toEqual(['atemschutz.status', 'atemschutz.notfall', 'atemschutz.notfallEnde'])
  })

  it('«Raus» ends a running Notfall in the same act, and ONE ↶ puts the crew back inside and in it', () => {
    const b = clockBoard([trupp({ status: 'aktiv', entryTime: at(0), lastContactTime: at(0), notfallAt: at(2) })])
    tick(9)
    b.act().setTruppStatus('T1', 'raus')
    expect(b.t()).toMatchObject({ status: 'raus', exitTime: at(9) })
    expect(b.t().notfallAt).toBeUndefined()
    expect(b.t().readings?.map((r) => r.kind)).toEqual(['exit', 'notfallEnde'])
    expect(b.events).toEqual(['atemschutz.status', 'atemschutz.notfallEnde'])

    b.timeline.undo()
    expect(b.t()).toMatchObject({ status: 'aktiv', notfallAt: at(2) })
    expect(b.t().exitTime).toBeUndefined()
  })
})

// FEEDBACK.1 (17.11.2026): the missing Sicherungstrupp is a standing Meldeleiste row now
// (components/SafetyMissingMeldung · lib/atemschutz · safetyMissing), not a toast at the Eintritt
describe('truppClockActions — the Sicherungstrupp hint', () => {
  it('writes the Eintritt without a toast – the standing row says it while it is true', () => {
    const b = clockBoard([trupp()])
    b.act().setTruppStatus('T1', 'aktiv')
    expect(ui.toasts).toEqual([])
    expect(b.t().status).toBe('aktiv')
  })
})
