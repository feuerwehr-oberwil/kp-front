import { describe, expect, it } from 'vitest'
import type { TimelineEvent, Trupp, TruppReading } from '../types'
import type { ChecklistTemplate } from './checklists'
import {
  auswertungForPdf, computeAuswertung, contactIntervals, hadAtemschutzDeployment, phaseLanes, tickStepMin, truppStretches, verlaufMilestones,
  type AuswertungInput,
} from './auswertung'

const DAY = '2026-09-20'
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00`).toISOString()
const ms = (hhmm: string, day = DAY) => Date.parse(at(hhmm, day))
const r = (hhmm: string, kind: TruppReading['kind'], bar = 250): TruppReading => ({ t: at(hhmm), bar, kind })

function trupp(over: Partial<Trupp> & { readings: TruppReading[] }): Trupp {
  return {
    id: 't1', no: 1, name: 'Meier Anna', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'raus',
    ...over,
  }
}

const base = (over: Partial<AuswertungInput> = {}): AuswertungInput => ({
  alarmedAt: at('10:00'), endedAt: at('11:00'), now: ms('12:00'),
  vehicles: [], trupps: [], contactIntervalMin: 5, contactGraceSec: 60, events: [],
  ...over,
})

describe('truppStretches + contactIntervals', () => {
  // entry 10:10, contacts after 4 · 5.5 · 10.5 min, exit 2 min later
  const t = trupp({
    readings: [
      r('10:07', 'registered'), r('10:10', 'entry'), r('10:14', 'contact'), { t: new Date(ms('10:19') + 30_000).toISOString(), bar: 220, kind: 'pressure' },
      r('10:30', 'contact'), r('10:31', 'crew'), r('10:32', 'exit'),
    ],
  })

  it('reads the run, the watched stretch, the standby and the contacts off the log', () => {
    const s = truppStretches(t, ms('11:00'))
    expect(s.standby).toEqual([{ from: ms('10:07'), to: ms('10:10') }])
    expect(s.runs).toEqual([{ from: ms('10:10'), to: ms('10:32'), open: false }])
    expect(s.watched).toEqual(s.runs)
    // a crew row is not a contact
    expect(s.contacts).toHaveLength(3)
  })

  it('counts an interval past interval + grace as an overrun, and marks fällig and überfällig apart', () => {
    const { stats, gaps } = contactIntervals(truppStretches(t, ms('11:00')), 5, 60)
    expect(stats).toEqual({ intervals: 4, kept: 3, overruns: 1 })
    // 5.5 min: fällig for the last half minute, never überfällig
    expect(gaps[0]).toEqual({ from: ms('10:19'), to: ms('10:19') + 30_000, level: 1 })
    // 10.5 min from 10:19:30: fällig 10:24:30–10:25:30, then red to the contact at 10:30
    expect(gaps.slice(1)).toEqual([
      { from: ms('10:24') + 30_000, to: ms('10:25') + 30_000, level: 1 },
      { from: ms('10:25') + 30_000, to: ms('10:30'), level: 2 },
    ])
  })

  it('reaching exactly interval + grace is überfällig, like the board (contactSeverity)', () => {
    const s = truppStretches(trupp({ readings: [r('10:00', 'entry'), r('10:06', 'contact'), r('10:08', 'exit')] }), 0)
    expect(contactIntervals(s, 5, 60).stats).toEqual({ intervals: 2, kept: 1, overruns: 1 })
  })

  it('an OPEN interval counts only once it is already overdue', () => {
    const readings = [r('10:00', 'entry'), r('10:04', 'contact')]
    const fresh = truppStretches(trupp({ readings, status: 'aktiv' }), ms('10:07'))
    expect(fresh.watched[0].open).toBe(true)
    expect(contactIntervals(fresh, 5, 60).stats).toEqual({ intervals: 1, kept: 1, overruns: 0 })
    const stale = truppStretches(trupp({ readings, status: 'aktiv' }), ms('10:20'))
    expect(contactIntervals(stale, 5, 60).stats).toEqual({ intervals: 2, kept: 1, overruns: 1 })
  })

  it('watches only the stretch between paOn and paOff of a work squad', () => {
    const s = truppStretches(trupp({
      kind: 'einfach',
      readings: [r('10:00', 'entry'), r('10:03', 'contact'), r('10:05', 'paOn'), r('10:08', 'contact'), r('10:15', 'paOff'), r('10:20', 'exit')],
    }), 0)
    expect(s.runs).toEqual([{ from: ms('10:00'), to: ms('10:20'), open: false }])
    expect(s.watched).toEqual([{ from: ms('10:05'), to: ms('10:15'), open: false }])
    // the 10:03 «contact» of the unwatched part is no Funkkontakt of a PA Trupp
    expect(s.contacts).toEqual([ms('10:08')])
  })

  it('draws «ohne Atemschutz» only for what is left of a run outside its watched stretch', () => {
    const t = trupp({ kind: 'einfach', readings: [r('10:00', 'entry'), r('10:05', 'paOn'), r('10:15', 'paOff'), r('10:20', 'exit')] })
    const lane = computeAuswertung(base({ trupps: [t] })).trupps[0]
    expect(lane.bars.filter((b) => b.kind === 'work')).toEqual([
      { from: ms('10:00'), to: ms('10:05'), kind: 'work' }, { from: ms('10:15'), to: ms('10:20'), kind: 'work' },
    ])
    const pa = computeAuswertung(base({ trupps: [trupp({ readings: [r('10:00', 'entry'), r('10:20', 'exit')] })] })).trupps[0]
    expect(pa.bars.map((b) => b.kind)).toEqual(['as'])
  })

  it('a PA Trupp downgraded mid-run stops being watched at the paOff', () => {
    const s = truppStretches(trupp({ kind: 'einfach', readings: [r('10:00', 'entry'), r('10:10', 'paOff'), r('10:30', 'exit')] }), 0)
    expect(s.watched).toEqual([{ from: ms('10:00'), to: ms('10:10'), open: false }])
  })

  it('a Trupp with no log at all has a run but no contact intervals to judge', () => {
    const s = truppStretches(trupp({ readings: [], entryTime: at('10:00'), exitTime: at('10:40') }), 0)
    expect(s.watched).toHaveLength(1)
    expect(contactIntervals(s, 5, 60)).toEqual({ gaps: [], stats: { intervals: 0, kept: 0, overruns: 0 } })
  })
})

describe('milestones and phases', () => {
  const ev = (hhmm: string, text: string): TimelineEvent => ({ id: hhmm + text, t: hhmm, at: at(hhmm), icon: 'check', text, kind: 'journal' })

  it('keeps the ☑ rows that stand and drops the ones taken back', () => {
    const m = verlaufMilestones([
      ev('10:20', '☑ Feuer unter Kontrolle'),
      ev('10:25', '☑ Gefahrenbereich frei'),
      ev('10:26', 'Meilenstein zurückgenommen: Gefahrenbereich frei'),
      ev('10:40', '☑ Feuer aus'),
      ev('10:41', 'Trupp 1 eingerückt'),
    ])
    expect(m).toEqual([{ label: 'Feuer unter Kontrolle', at: ms('10:20') }, { label: 'Feuer aus', at: ms('10:40') }])
  })

  it('bands each checklist phase from its first to its last tick', () => {
    const tpl: ChecklistTemplate = {
      id: 'fu', kind: 'action', title: 'FU', version: 1, source: 'test',
      phases: [
        { id: 'p1', title: 'Erkunden', items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
        { id: 'p2', title: 'Abschluss', items: [{ id: 'c', text: 'C' }] },
      ],
    }
    const lanes = phaseLanes({ fu: { ticks: { a: { t: at('10:05') }, b: { t: at('10:12') } } } }, [tpl])
    expect(lanes).toEqual([{ label: 'Erkunden', bars: [{ from: ms('10:05'), to: ms('10:12'), kind: 'phase' }], marks: [], contacts: [], gaps: [] }])
  })
})

describe('computeAuswertung', () => {
  it('says nothing it does not know: no alarm, no vehicles, no Trupps → every figure missing', () => {
    const a = computeAuswertung(base({ alarmedAt: null, endedAt: null }))
    expect(a.firstOnScene).toBeNull()
    expect(a.firstAs).toBeNull()
    expect(a.contacts).toBeNull()
    expect(a.longestAs).toBeNull()
    expect(a.totalMs).toBeNull()
    const pdf = auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 60 })
    expect(pdf.figures.map((f) => f.value)).toEqual(['—', '—', '—', '—', '—'])
    expect(pdf.figures.every((f) => !!f.footnote)).toBe(true)
    expect(pdf.timeline).toBeNull()
    expect(pdf.noTimeline).toBeTruthy()
  })

  it('times the first vehicle on scene and the first PA entry from the alarm', () => {
    const a = computeAuswertung(base({
      vehicles: [
        { label: 'MTF', zeit: { id: 'mtf', ausgerueckt: at('10:06') } },
        { label: 'TLF', zeit: { id: 'tlf', ausgerueckt: at('10:03'), vorOrt: at('10:09'), zurueck: at('11:10'), gps: { zone: 'away', ab: at('10:50') } } },
        { label: 'ADL', zeit: { id: 'adl', ausgerueckt: at('10:04'), vorOrt: at('10:11') } },
      ],
      trupps: [
        trupp({ id: 'a', no: 2, name: 'Keller Laura', readings: [r('10:20', 'entry'), r('10:24', 'contact'), r('10:44', 'exit')] }),
        trupp({ id: 'b', no: 1, readings: [r('10:14', 'entry'), r('10:18', 'contact'), r('10:22', 'exit')] }),
      ],
    }))
    expect(a.firstOnScene).toEqual({ at: ms('10:09'), ms: 9 * 60_000, label: 'TLF' })
    expect(a.firstAs).toMatchObject({ ms: 14 * 60_000, label: 'Trupp 1 · Meier Anna' })
    expect(a.longestAs).toEqual({ ms: 24 * 60_000, label: 'Trupp 2 · Keller Laura' })
    expect(a.totalMs).toBe(60 * 60_000)
    // the TLF: Anfahrt, vor Ort until the GPS saw it leave, then the Rückfahrt
    expect(a.vehicles.find((v) => v.label === 'TLF')!.bars.map((b) => b.kind)).toEqual(['travel', 'scene', 'return'])
    // the MTF never reported vor Ort: one mark, no invented span
    expect(a.vehicles.find((v) => v.label === 'MTF')).toMatchObject({ bars: [], marks: [ms('10:06')] })
    // the axis reaches the TLF's return past the Einsatzende
    expect(a.t1).toBe(ms('11:10'))

    const pdf = auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 60 }, '  Zufahrt zu eng  ')
    expect(pdf.figures.map((f) => f.value)).toEqual(['9 min', '14 min', '75 %', '24 min', '1 h 00'])
    expect(pdf.figures[2]).toMatchObject({ sub: '1 überfällig von 4', alert: true })
    expect(pdf.figures[2].footnote).toContain('(5 min + 1 min)')
    // a grace under a minute is printed as it is, not rounded away (review of #303)
    expect(auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 20 }).figures[2].footnote).toContain('(5 min + 20 s)')
    expect(auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 90 }).figures[2].footnote).toContain('(5 min + 1 min 30 s)')
    expect(auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 0 }).figures[2].footnote).toContain('(5 min)')
    // the Lehren print on page 1 only — the sheet points there (review of #303)
    expect(pdf.lehrenNote).toBe('Lehren / Sicherheit: siehe Seite 1')
    expect(JSON.stringify(pdf)).not.toContain('Zufahrt zu eng')
    expect(auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 60 }, '  ').lehrenNote).toBeUndefined()
    expect(pdf.timeline!.groups.map((g) => g.label)).toEqual(['Fahrzeuge', 'Trupps'])
    // minutes after the axis start, not instants
    expect(pdf.timeline!.groups[0].lanes[0].marks).toEqual([6])
  })

  it('a Trupp still inside on a running Einsatz is not the longest deployment, and the total is open', () => {
    const a = computeAuswertung(base({
      endedAt: null, now: ms('10:30'),
      trupps: [trupp({ status: 'aktiv', readings: [r('10:05', 'entry'), r('10:08', 'contact')] })],
    }))
    expect(a.longestAs).toBeNull()
    expect(a.totalMs).toBeNull()
    const pdf = auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 60 })
    expect(pdf.figures[4]).toMatchObject({ value: '—', sub: 'Einsatz läuft noch' })
    // the open stretch is drawn up to now
    expect(pdf.timeline!.groups[0].lanes[0].bars.find((b) => b.kind === 'as')!.end).toBe(30)
  })

  it('an Einsatz over midnight dates its clocks and its total runs past 24 h', () => {
    const a = computeAuswertung(base({
      alarmedAt: at('23:30'), endedAt: at('01:10', '2026-09-22'),
      vehicles: [{ label: 'TLF', zeit: { id: 'tlf', ausgerueckt: at('23:34'), vorOrt: at('23:41') } }],
      events: [{ id: 'm', t: '00:20', at: at('00:20', '2026-09-21'), icon: 'check', text: '☑ Feuer aus', kind: 'journal' }],
    }))
    expect(a.totalMs).toBe((24 * 60 + 100) * 60_000)
    const pdf = auswertungForPdf(a, { contactIntervalMin: 5, contactGraceSec: 60 })
    expect(pdf.figures[4].value).toBe('25 h 40')
    expect(pdf.figures[0].sub).toMatch(/^TLF · 20\.09\. 23:41$/)
    expect(pdf.timeline!.milestones).toEqual([{ at: 50, label: 'Feuer aus', time: '21.09. 00:20' }])
    // the ticks land on round clock times and carry the day
    expect(pdf.timeline!.ticks.length).toBeGreaterThanOrEqual(5)
    expect(pdf.timeline!.ticks.length).toBeLessThanOrEqual(13)
    expect(pdf.timeline!.ticks.every((t) => /^\d{2}\.\d{2}\. \d{2}:00$/.test(t.label))).toBe(true)
  })

  it('symbols marked «gelöscht» join the milestones in time order', () => {
    const a = computeAuswertung(base({
      doneMarks: [{ at: at('10:40'), label: 'Feuer gelöscht' }, { at: 'kaputt', label: 'x' }],
      events: [{ id: 'm', t: '10:20', at: at('10:20'), icon: 'check', text: '☑ Feuer unter Kontrolle', kind: 'journal' }],
    }))
    expect(a.milestones.map((m) => m.label)).toEqual(['Feuer unter Kontrolle', 'Feuer gelöscht'])
  })
})

describe('review of #303', () => {
  const sys = (id: string, hhmm: string, lifecycle: 'closed' | 'reopened'): TimelineEvent =>
    ({ id, t: hhmm, at: at(hhmm), icon: 'lock', text: lifecycle === 'closed' ? 'Einsatz abgeschlossen' : 'Einsatz wiedereröffnet', lifecycle } as TimelineEvent)

  it('a Trupp taken off the Tafel ends where it was removed, and its open time is no overrun', () => {
    const t = trupp({ status: 'aktiv', removedAt: at('10:12'), readings: [r('10:05', 'entry'), r('10:08', 'contact')] })
    const a = computeAuswertung(base({ trupps: [t] }))
    expect(a.trupps[0].bars).toEqual([{ from: ms('10:05'), to: ms('10:12'), kind: 'as' }])
    expect(a.contacts).toEqual({ intervals: 1, kept: 1, overruns: 0 })
    expect(a.trupps[0].gaps).toEqual([])
  })

  it('an Anmeldung taken back (removed, never went in) is not on the sheet', () => {
    const t = trupp({ removedAt: at('10:06'), readings: [r('10:05', 'registered')] })
    expect(computeAuswertung(base({ trupps: [t] })).trupps).toEqual([])
  })

  it('the closed stretch before a reopen is no phantom überfällig — the clock restarts at the reopen', () => {
    // in at 10:00, contact 10:03, closed 10:05, reopened 10:40, contact 10:43, out 10:45
    const t = trupp({ readings: [r('10:00', 'entry'), r('10:03', 'contact'), r('10:43', 'contact'), r('10:45', 'exit')] })
    const a = computeAuswertung(base({ trupps: [t], events: [sys('sys1', '10:05', 'closed'), sys('sys2', '10:40', 'reopened')] }))
    expect(a.trupps[0].gaps).toEqual([])
    // 10:00–10:03, 10:40–10:43, 10:43–10:45 — the one the close cut short is open and was not overdue
    expect(a.contacts).toEqual({ intervals: 3, kept: 3, overruns: 0 })
    // without the lifecycle rows the same log WOULD read as an overrun
    expect(computeAuswertung(base({ trupps: [t] })).contacts!.overruns).toBe(1)
  })

  it('a shuttle to the depot does not end the vehicle\'s stay — only a departure while AWAY does', () => {
    const shuttle = computeAuswertung(base({
      vehicles: [{ label: 'TLF', zeit: { id: 'tlf', ausgerueckt: at('10:03'), vorOrt: at('10:09'), gps: { zone: 'scene', ab: at('10:20'), fahrten: 2 } } }],
    }))
    expect(shuttle.vehicles[0].bars.find((b) => b.kind === 'scene')!.to).toBe(ms('11:00'))
    const away = computeAuswertung(base({
      vehicles: [{ label: 'TLF', zeit: { id: 'tlf', vorOrt: at('10:09'), gps: { zone: 'away', ab: at('10:50') } } }],
    }))
    expect(away.vehicles[0].bars.find((b) => b.kind === 'scene')!.to).toBe(ms('10:50'))
  })

  it('a mistyped year does not stretch the axis', () => {
    const a = computeAuswertung(base({
      vehicles: [
        { label: 'TLF', zeit: { id: 'tlf', ausgerueckt: at('10:03'), vorOrt: at('10:09'), zurueck: at('11:10', '2027-09-20') } },
        { label: 'ADL', zeit: { id: 'adl', ausgerueckt: at('10:04', '2025-09-20') } },
      ],
    }))
    expect(a.t0).toBe(ms('10:00'))
    expect(a.t1).toBeLessThanOrEqual(ms('13:00'))
    // the stray Ausgerückt a year early is off the picture, the TLF's stay is cut at the edge
    expect(a.vehicles.map((v) => v.label)).toEqual(['TLF'])
  })
})

describe('hadAtemschutzDeployment — the default of the «Auswertung (intern)» tick', () => {
  it('is true once a crew went in under PA — also one taken off the Tafel afterwards', () => {
    expect(hadAtemschutzDeployment([trupp({ readings: [r('10:00', 'entry'), r('10:20', 'exit')] })])).toBe(true)
    expect(hadAtemschutzDeployment([trupp({ removedAt: at('10:30'), readings: [r('10:00', 'entry'), r('10:20', 'exit')] })])).toBe(true)
    // a work squad that put masks on mid-run
    expect(hadAtemschutzDeployment([trupp({ kind: 'einfach', readings: [r('10:00', 'entry'), r('10:05', 'paOn'), r('10:20', 'exit')] })])).toBe(true)
  })

  it('is false with no Trupp, a Sicherungstrupp that never went in, or a work squad without PA', () => {
    expect(hadAtemschutzDeployment([])).toBe(false)
    expect(hadAtemschutzDeployment([trupp({ readings: [r('10:00', 'registered'), r('10:40', 'exit')] })])).toBe(false)
    expect(hadAtemschutzDeployment([trupp({ kind: 'einfach', readings: [r('10:00', 'entry'), r('10:20', 'exit')] })])).toBe(false)
  })
})

describe('tickStepMin', () => {
  it('keeps the axis between a handful and a dozen labels', () => {
    expect(tickStepMin(22)).toBe(5)
    expect(tickStepMin(90)).toBe(10)
    expect(tickStepMin(5 * 60)).toBe(30)
    expect(tickStepMin(26 * 60)).toBe(180)
    expect(tickStepMin(30 * 24 * 60)).toBeGreaterThanOrEqual(1440)
  })
})
