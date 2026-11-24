import { expect, it } from 'vitest'
import type { Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { truppStretches } from './auswertung'
import { defaultReportOptions, formatDateTime, truppCrewHistory } from './report'
import { buildDirectReportPayload, type DirectReportArgs } from './reportPdfDirect'

// Hunt 24.11.2026, records-rapport F2 + F3: a Trupp's deployments as the Rapport and the
// Auswertung read them – per run under PA or not, and each Eintritt with its own Austritt.

const time = (minute: number) => `2026-11-24T08:${String(minute).padStart(2, '0')}:00.000Z`

function trupp(overrides: Partial<Trupp>): Trupp {
  return {
    id: 'crew-1', no: 1, name: 'Müller Lea', status: 'raus',
    entryTime: time(40), lastContactTime: time(40), exitTime: time(49),
    entryPressureBar: 300, ...overrides,
  }
}

function reportArgs(trupps: Trupp[]): DirectReportArgs {
  return {
    incident: {
      id: 'local-repro', title: 'Übung Ölspur', started_at: time(0),
      is_exercise: true, is_archived: false,
    } as DirectReportArgs['incident'],
    draft: {
      meta: {}, generatedAt: time(55), proof: { intact: null, checkedAt: time(55) },
      options: { ...defaultReportOptions, auswertung: true },
    },
    trupps, events: [], attendance: {}, plans: [],
  }
}

function report(trupps: Trupp[]) {
  return buildDirectReportPayload(reportArgs(trupps))
}

it('keeps the first PA run on the Atemschutz sheet after a plain redeployment', () => {
  const t = trupp({
    kind: 'einfach', entryPressureBar: 0,
    readings: [
      { kind: 'entry', t: time(10), bar: 300 },
      { kind: 'pressure', t: time(15), bar: 240 },
      { kind: 'exit', t: time(20), bar: 180, measured: true },
      { kind: 'entry', t: time(40), bar: 0 },
      { kind: 'exit', t: time(49), bar: 0 },
    ],
  })
  expect.soft(report([t]).trupps).toEqual([
    expect.objectContaining({ name: 'Müller Lea' }),
  ])
  expect.soft(truppStretches(t, Date.parse(time(55))).watched).toEqual([
    { from: Date.parse(time(10)), to: Date.parse(time(20)), open: false },
  ])
})

it('pairs each real entry with its exit, skipping a stand-down before it', () => {
  const t = trupp({
    readings: [
      { kind: 'registered', t: time(5), bar: 300 },
      { kind: 'exit', t: time(20), bar: 300 },
      { kind: 'registered', t: time(35), bar: 300 },
      { kind: 'entry', t: time(40), bar: 300 },
      { kind: 'exit', t: time(49), bar: 150, measured: true },
    ],
  })
  const payload = report([t])
  expect.soft(payload.trupps).toEqual([
    expect.objectContaining({ cycles: [expect.objectContaining({
      entry: formatDateTime(time(40)), exit: formatDateTime(time(49)),
    })] }),
  ])
  expect(truppCrewHistory(t).cycles[0].exit).toBe(time(49))
})

it('a run recorded with its Art keeps it, in either direction', () => {
  const t = trupp({
    kind: 'atemschutz',
    readings: [
      { kind: 'entry', t: time(10), bar: 0, pa: false },
      { kind: 'exit', t: time(20), bar: 0 },
      { kind: 'entry', t: time(40), bar: 300, pa: true },
      { kind: 'exit', t: time(49), bar: 200, measured: true },
    ],
  })
  expect(truppStretches(t, Date.parse(time(55))).watched).toEqual([
    { from: Date.parse(time(40)), to: Date.parse(time(49)), open: false },
  ])
})

it('an older PA run known only by its Eingangsdruck stays watched after a plain re-entry', () => {
  const t = trupp({
    kind: 'einfach',
    readings: [
      { kind: 'entry', t: time(10), bar: 300 },
      { kind: 'exit', t: time(20), bar: 300 },
      { kind: 'entry', t: time(40), bar: 0, pa: false },
      { kind: 'exit', t: time(49), bar: 0 },
    ],
  })
  expect(truppStretches(t, Date.parse(time(55))).watched).toEqual([
    { from: Date.parse(time(10)), to: Date.parse(time(20)), open: false },
  ])
})

it('a new Anmeldung ends a run whose Austritt was never written; a later stand-down is not its exit', () => {
  const t = trupp({
    readings: [
      { kind: 'entry', t: time(5), bar: 300 },
      { kind: 'registered', t: time(30), bar: 300 },
      { kind: 'exit', t: time(35), bar: 300 },
    ],
  })
  expect(truppCrewHistory(t).cycles.map((c) => [c.entry, c.exit])).toEqual([[time(5), undefined]])
})

it('the sheet says the Austritt is missing for a run a new Anmeldung ended, and the watch stops there', () => {
  const t = trupp({
    readings: [
      { kind: 'entry', t: time(5), bar: 300 },
      { kind: 'registered', t: time(30), bar: 300 },
      { kind: 'exit', t: time(35), bar: 300 },
    ],
  })
  expect(report([t]).trupps).toEqual([expect.objectContaining({ cycles: [expect.objectContaining({ entry: formatDateTime(time(5)), exit: appConfig.copy.atemschutz.cycleNoExit })] })])
  const s = truppStretches(t, Date.parse(time(55)))
  expect(s.watched).toEqual([{ from: Date.parse(time(5)), to: Date.parse(time(30)), open: false }])
  expect(s.standby[0]?.from).toBe(Date.parse(time(30)))
})

it('a crew switched to «ohne Atemschutz» while waiting goes in unwatched, whatever pressure the old Eintritt copied', () => {
  const t = trupp({
    kind: 'einfach',
    readings: [
      { kind: 'registered', t: time(5), bar: 300 },
      { kind: 'paOff', t: time(8), bar: 300 },
      { kind: 'entry', t: time(10), bar: 300 },
      { kind: 'exit', t: time(20), bar: 300 },
    ],
  })
  expect(truppStretches(t, Date.parse(time(55))).watched).toEqual([])
})
