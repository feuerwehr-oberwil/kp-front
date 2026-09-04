import { describe, expect, it } from 'vitest'
import { alarmBarFor, anyTruppInField, contactSeverity, deriveTruppLive, estimatePressure, fmtClock, isAtemschutzTrupp, peakAtemschutzAlarm, pressureAlarm, truppAlarm, truppInField, truppLogName, truppNeverDeployed, truppStillDeployed } from './atemschutz'
import type { Trupp } from '../types'

// A Trupp that entered at a fixed reference time; its contact clock starts at entry.
const REF = Date.parse('2026-06-21T10:00:00Z')
const base: Trupp = {
  id: 't1',
  name: 'Müller',
  entryPressureBar: 300,
  entryTime: '2026-06-21T10:00:00Z',
  lastContactTime: '2026-06-21T10:00:00Z',
  status: 'aktiv',
}

describe('deriveTruppLive', () => {
  it('counts elapsed time since entry and contact since the last contact', () => {
    const live = deriveTruppLive(base, REF + 3 * 60_000, 5, 60)
    expect(live.elapsedSec).toBe(180)
    expect(live.sinceContactSec).toBe(180)
    expect(live.status).toBe('aktiv')
    expect(live.overdue).toBe(false)
    expect(live.currentBar).toBe(300) // no reading yet → entry pressure
    expect(live.lowestBar).toBe(300)
  })

  it('resets the contact clock from lastContactTime', () => {
    const t: Trupp = { ...base, lastContactTime: '2026-06-21T10:04:00Z' }
    const live = deriveTruppLive(t, REF + 5 * 60_000, 5, 60)
    expect(live.sinceContactSec).toBe(60) // 5:00 now − 4:00 last contact
    expect(live.status).toBe('aktiv')
  })

  it('shows the last reading + the lowest pressure', () => {
    const t: Trupp = { ...base, lastPressureBar: 150, lowestBar: 120 }
    const live = deriveTruppLive(t, REF + 6 * 60_000, 5, 60)
    expect(live.currentBar).toBe(150)
    expect(live.lowestBar).toBe(120)
  })

  it('escalates to ueberfaellig once contact runs past interval + Nachfrist', () => {
    // last contact at entry, interval 5 min + Nachfrist 60 s ⇒ overdue from 6:00
    const still = deriveTruppLive(base, REF + 5.5 * 60_000, 5, 60)
    expect(still.overdue).toBe(false) // 5:30 — fällig (amber), not yet überfällig
    expect(still.status).toBe('aktiv')
    const live = deriveTruppLive(base, REF + 6 * 60_000, 5, 60)
    expect(live.sinceContactSec).toBe(6 * 60)
    expect(live.overdue).toBe(true)
    expect(live.status).toBe('ueberfaellig')
  })

  it('overdue (contact lost) beats a manual Rückzug', () => {
    const t: Trupp = { ...base, status: 'rueckzug', lastContactTime: '2026-06-21T10:00:00Z' }
    const live = deriveTruppLive(t, REF + 6 * 60_000, 5, 60)
    expect(live.status).toBe('ueberfaellig')
  })

  it('keeps a manual Rückzug while contact is fresh', () => {
    const t: Trupp = { ...base, status: 'rueckzug', lastContactTime: '2026-06-21T10:05:00Z' }
    const live = deriveTruppLive(t, REF + 6 * 60_000, 5, 60)
    expect(live.status).toBe('rueckzug')
  })

  it('treats an explicit exit as raus regardless of contact', () => {
    const t: Trupp = { ...base, status: 'raus', exitTime: '2026-06-21T10:08:00Z' }
    const live = deriveTruppLive(t, REF + 30 * 60_000, 5, 60)
    expect(live.status).toBe('raus')
    expect(live.sinceContactSec).toBeNull() // clock stops once out
  })

  it('stops the Einsatzzeit at the exit and starts the break clock instead', () => {
    const t: Trupp = { ...base, status: 'raus', exitTime: '2026-06-21T10:08:00Z' }
    const live = deriveTruppLive(t, REF + 30 * 60_000, 5, 60)
    expect(live.elapsedSec).toBe(8 * 60) // the deployment lasted 8 minutes — not 30
    expect(live.outSec).toBe(22 * 60) // …and the crew has been out for 22
  })

  it('has no break clock while the Trupp is still in', () => {
    expect(deriveTruppLive(base, REF + 3 * 60_000, 5, 60).outSec).toBeNull()
  })

  it('falls back to entryTime when lastContactTime is empty — no dead clock for an in-field Trupp', () => {
    // an in-field Trupp that never got an explicit contact (or legacy data) must still be timed
    const t: Trupp = { ...base, lastContactTime: '' }
    const live = deriveTruppLive(t, REF + 6 * 60_000, 5, 60)
    expect(live.sinceContactSec).toBe(6 * 60) // counted from entryTime, not null
    expect(live.status).toBe('ueberfaellig')
  })

  it('keeps an angemeldet Trupp out of the contact clock', () => {
    const t: Trupp = { ...base, status: 'angemeldet', entryTime: '', lastContactTime: '' }
    const live = deriveTruppLive(t, REF + 30 * 60_000, 5, 60)
    expect(live.status).toBe('angemeldet')
    expect(live.elapsedSec).toBe(0)
    expect(live.sinceContactSec).toBeNull()
  })
})

describe('estimatePressure (Planungshilfe — expected pressure)', () => {
  const pressure = (minute: number, bar: number) => ({
    t: new Date(REF + minute * 60_000).toISOString(), bar, kind: 'pressure' as const,
  })

  it('uses the configured assumption until a measured pressure drop exists', () => {
    const estimate = estimatePressure(base, REF + 7 * 60_000, 7, 50)
    expect(estimate).toMatchObject({
      bar: 250,
      source: 'assumption',
      rateBarPerMin: 50 / 7,
      basedAt: new Date(REF).toISOString(),
      sampleCount: 1,
    })
  })

  it('projects from confirmed pressure consumption instead of the assumed rate', () => {
    const t: Trupp = {
      ...base,
      readings: [pressure(5, 270), pressure(10, 240)],
      lastPressureBar: 240,
      lastPressureTime: pressure(10, 240).t,
    }
    // 60 bar used in 10 min = 6 bar/min; two more min from the latest 240 bar reading => 228.
    expect(estimatePressure(t, REF + 12 * 60_000, 7, 50)).toMatchObject({
      bar: 228,
      source: 'history',
      rateBarPerMin: 6,
      basedAt: pressure(10, 240).t,
      sampleCount: 3,
    })
  })

  it('uses real intervals and ignores contact rows that repeat the last pressure', () => {
    const t: Trupp = {
      ...base,
      readings: [
        { t: new Date(REF + 5 * 60_000).toISOString(), bar: 300, kind: 'contact' },
        pressure(16, 220),
      ],
    }
    // 80 bar in 16 min = 5 bar/min; contact at minute 5 is not a measurement.
    expect(estimatePressure(t, REF + 20 * 60_000, 7, 50)).toMatchObject({
      bar: 200,
      source: 'history',
      rateBarPerMin: 5,
      sampleCount: 2,
    })
  })

  // ⚠️ Revised 11.08.: a rise no longer restarts the history. A Trupp does not change cylinders
  // inside a burning building, so a value going up is a CORRECTION of what was typed — and
  // restarting cost the estimate its whole span, leaving it projecting off the last two minutes
  // for the rest of the Einsatz. Eingangsdruck against the latest reading, over the whole time
  // under PA, whatever happened in between.
  it('measures from the Eingangsdruck to the latest reading, across a rise', () => {
    const t: Trupp = {
      ...base,
      readings: [pressure(10, 200), pressure(11, 300), pressure(15, 280)],
    }
    // entry 300 → 280 over the 15 min since Eintritt = 1.33 bar/min, projected 2 min further
    expect(estimatePressure(t, REF + 17 * 60_000, 7, 50)).toMatchObject({
      bar: 277,
      source: 'history',
      basedAt: pressure(15, 280).t,
      sampleCount: 4,
    })
  })

  // …and a «current» ABOVE the Eingangsdruck yields no positive rate at all. The honest answer
  // to a record that contradicts itself is the configured assumption, not a negative consumption.
  it('falls back to the assumption when the latest reading is above the Eingangsdruck', () => {
    const t: Trupp = { ...base, readings: [pressure(10, 320)] }
    expect(estimatePressure(t, REF + 12 * 60_000, 7, 50)).toMatchObject({ source: 'assumption' })
  })

  it('re-anchors the fallback at a confirmed value when no drop was measured', () => {
    const t: Trupp = { ...base, readings: [pressure(5, 300)] }
    const estimate = estimatePressure(t, REF + 7 * 60_000, 7, 50)
    expect(estimate).toMatchObject({
      bar: 286,
      source: 'assumption',
      basedAt: pressure(5, 300).t,
      sampleCount: 2,
    })
  })

  it('uses measured history even when fallback assumptions are unavailable', () => {
    const t: Trupp = { ...base, readings: [pressure(10, 250)] }
    expect(estimatePressure(t, REF + 12 * 60_000, 0, 0)).toMatchObject({
      bar: 240,
      source: 'history',
      rateBarPerMin: 5,
    })
  })

  it('never goes negative and rejects unusable data', () => {
    const t: Trupp = { ...base, readings: [pressure(10, 250)] }
    expect(estimatePressure(t, REF + 120 * 60_000, 7, 50)?.bar).toBe(0)
    expect(estimatePressure(base, REF - 60_000, 7, 50)?.bar).toBe(300)
    expect(estimatePressure({ ...base, entryTime: '' }, REF, 7, 50)).toBeNull()
    expect(estimatePressure(base, REF, 0, 0)).toBeNull()
  })
})

describe('contactSeverity', () => {
  it('is silent, then amber from the interval, then critical after the Nachfrist', () => {
    expect(contactSeverity(0, 5, 60)).toBe(0) // fresh contact
    expect(contactSeverity(299, 5, 60)).toBe(0) // 4:59 — still silent
    expect(contactSeverity(300, 5, 60)).toBe(1) // 5:00 — Kontakt fällig (amber)
    expect(contactSeverity(359, 5, 60)).toBe(1) // 5:59 — still amber
    expect(contactSeverity(360, 5, 60)).toBe(2) // 6:00 — überfällig alarm
    expect(contactSeverity(null, 5, 60)).toBe(0) // not in the field
  })
})

describe('pressureAlarm (Alarmdruck)', () => {
  it('is silent above the Alarmdruck and fires at or below it', () => {
    expect(pressureAlarm(300, 100)).toBe(false)
    expect(pressureAlarm(101, 100)).toBe(false) // one bar above – still silent
    expect(pressureAlarm(100, 100)).toBe(true) // exactly the Alarmdruck
    expect(pressureAlarm(98, 100)).toBe(true) // the reported case: the Schätzung crossed it
    expect(pressureAlarm(0, 100)).toBe(true)
  })

  it('treats an unknown or non-finite pressure as silent rather than as empty', () => {
    expect(pressureAlarm(null, 100)).toBe(false)
    expect(pressureAlarm(Number.NaN, 100)).toBe(false)
  })

  it('lets a station switch the threshold off with 0, without a special case in the caller', () => {
    expect(pressureAlarm(0, 0)).toBe(false)
    expect(pressureAlarm(50, 0)).toBe(false)
  })
})

describe('fmtClock', () => {
  it('formats seconds as m:ss and handles unknown', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(600)).toBe('10:00')
    expect(fmtClock(null)).toBe('–:––')
  })
})

/* The ONE tier. It exists because the board and the app-wide alarm disagreed: from 10.08. the
 * Alarmdruck sounded the tone and reddened the TopBar chip while the Atemschutz card, its row,
 * the header badge and the «Dringlichkeit» sort still read the contact clock alone — so a Trupp
 * at 40 bar with a fresh Funkkontakt had the whole app screaming beside a green, unbadged card. */
describe('truppAlarm — one tier for tone, chip, card, row, badge and sort', () => {
  const live = (sinceContactSec: number | null, currentBar: number) => ({ sinceContactSec, currentBar })
  const doctrine = { alarmBar: 50, alarmBarRueckzug: 30 }

  it('is tier 2 with reason «pressure» at the Alarmdruck, whatever the contact clock says', () => {
    expect(truppAlarm({ status: 'aktiv' }, live(30, 40), 5, 60, doctrine))
      .toEqual({ sev: 2, reason: 'pressure', line: 50 })
  })

  it('pressure OUTRANKS an overdue contact — a radio check does not fix an empty cylinder', () => {
    const a = truppAlarm({ status: 'aktiv' }, live(9999, 40), 5, 60, doctrine)
    expect(a.sev).toBe(2)
    expect(a.reason).toBe('pressure')
  })

  it('holds a Trupp in Rückzug to the lower line (alarmBarFor)', () => {
    expect(truppAlarm({ status: 'rueckzug' }, live(30, 40), 5, 60, doctrine).reason).toBeNull()
    expect(truppAlarm({ status: 'rueckzug' }, live(30, 25), 5, 60, doctrine).reason).toBe('pressure')
  })

  it('has no amber half-step for pressure, but keeps the contact clock\'s', () => {
    expect(truppAlarm({ status: 'aktiv' }, live(5 * 60, 300), 5, 60, doctrine))
      .toEqual({ sev: 1, reason: 'contact', line: 50 })
  })

  it('is silent for a Trupp that is not in the field — no clock, no cylinder watched', () => {
    expect(truppAlarm({ status: 'raus' }, live(null, 10), 5, 60, doctrine))
      .toEqual({ sev: 0, reason: null, line: null })
  })

  it('a configured 0 switches the pressure line off without a special case', () => {
    expect(truppAlarm({ status: 'aktiv' }, live(30, 0), 5, 60, { alarmBar: 0 }).sev).toBe(0)
  })
})

describe('peakAtemschutzAlarm — the Alarmdruck reaches the app-wide surfaces too', () => {
  const REF = Date.parse('2026-08-10T12:00:00Z')
  const inField = (over: Partial<Trupp>): Trupp => ({
    id: 'T1', name: 'Angriff 1', entryPressureBar: 300, entryTime: '2026-08-10T11:58:00Z',
    lastContactTime: '2026-08-10T11:59:30Z', status: 'aktiv', ...over,
  })

  it('raises tier 2 for a Trupp at the Alarmdruck, even with a fresh Funkkontakt', () => {
    // it was on the card and nowhere else: nobody who was not looking at the board heard about it
    const r = peakAtemschutzAlarm([inField({ lastPressureBar: 100 })], REF, 10, 60, 100)
    expect(r.peak).toBe(2)
    expect(r.urgent?.reason).toBe('pressure')
    expect(r.urgent?.bar).toBe(100)
  })

  it('stays silent above the Alarmdruck', () => {
    expect(peakAtemschutzAlarm([inField({ lastPressureBar: 110 })], REF, 10, 60, 100).peak).toBe(0)
  })

  it('points at the Trupp with the LEAST air left when two are below it', () => {
    const r = peakAtemschutzAlarm(
      [inField({ id: 'a', name: 'A', lastPressureBar: 90 }), inField({ id: 'b', name: 'B', lastPressureBar: 60 })],
      REF, 10, 60, 100,
    )
    expect(r.urgent?.name).toBe('B')
    expect(r.severities).toEqual({ a: 2, b: 2 })
  })

  it('gives the one-slot app-wide warning to Alarmdruck ahead of missed contact', () => {
    const r = peakAtemschutzAlarm(
      [
        inField({ id: 'contact', name: 'Kontakt', lastContactTime: '2026-08-10T11:40:00Z' }),
        inField({ id: 'pressure', name: 'Druck', lastPressureBar: 100 }),
      ],
      REF, 5, 60, 100,
    )
    expect(r.urgent).toMatchObject({ id: 'pressure', reason: 'pressure', bar: 100 })
    expect(r.severities).toEqual({ contact: 2, pressure: 2 })
  })

  it('leaves the contact clock alone when no Alarmdruck is configured', () => {
    expect(peakAtemschutzAlarm([inField({ lastPressureBar: 10 })], REF, 10, 60).peak).toBe(0)
  })
})

describe('peakAtemschutzAlarm', () => {
  const at = (sinceContactMin: number, over: Partial<Trupp> = {}): Trupp => ({
    ...base,
    lastContactTime: new Date(REF - sinceContactMin * 60_000).toISOString(),
    entryTime: new Date(REF - Math.max(sinceContactMin, 1) * 60_000).toISOString(),
    ...over,
  })

  it('is silent when no Trupp is near the interval', () => {
    expect(peakAtemschutzAlarm([at(1)], REF, 5, 60)).toEqual({ peak: 0, urgent: null, severities: {} })
    expect(peakAtemschutzAlarm([], REF, 5, 60)).toEqual({ peak: 0, urgent: null, severities: {} })
  })

  it('reports the per-Trupp tier for the surfaces that draw a Trupp elsewhere (hose lines)', () => {
    const r = peakAtemschutzAlarm([{ ...at(1), id: 'quiet' }, { ...at(5), id: 'due' }, { ...at(7), id: 'over' }], REF, 5, 60)
    // only non-zero tiers ride along, so the map re-renders on a real transition and not per tick
    expect(r.severities).toEqual({ due: 1, over: 2 })
  })

  it('flags tier 1 (fällig) from the interval mark and names the Trupp', () => {
    const r = peakAtemschutzAlarm([{ ...at(5), name: 'Angriff' }], REF, 5, 60) // 5:00 — fällig, Nachfrist running
    expect(r.peak).toBe(1)
    // contactAt anchors the chip's self-ticking clock (the state object stays reference-stable)
    expect(r.urgent).toMatchObject({ name: 'Angriff', severity: 1, sinceContactSec: 300, contactAt: REF - 300_000 })
  })

  it('flags tier 2 (überfällig) past interval + Nachfrist', () => {
    const r = peakAtemschutzAlarm([at(6)], REF, 5, 60) // 6:00 ≥ 5:00 interval + 60 s Nachfrist
    expect(r.peak).toBe(2)
    expect(r.urgent?.severity).toBe(2)
  })

  it('picks the worst, longest-waiting Trupp as urgent', () => {
    const r = peakAtemschutzAlarm(
      [{ ...at(5), id: 'a', name: 'Warn' }, { ...at(7), id: 'b', name: 'Over' }, { ...at(6), id: 'c', name: 'OverLess' }],
      REF, 5, 60,
    )
    expect(r.peak).toBe(2)
    expect(r.urgent?.name).toBe('Over') // tier 2 beats tier 1; among tier-2 the longest wins
  })

  it('ignores Trupps not in the field (angemeldet / raus)', () => {
    expect(peakAtemschutzAlarm([at(9, { status: 'raus', exitTime: base.entryTime })], REF, 5, 60).peak).toBe(0)
    expect(peakAtemschutzAlarm([at(9, { status: 'angemeldet' })], REF, 5, 60).peak).toBe(0)
  })
})

describe('truppInField / anyTruppInField (1 Hz tick gate)', () => {
  it('is true for an entered, still-in Trupp', () => {
    expect(truppInField(base)).toBe(true) // aktiv, entryTime set, no exit
    expect(truppInField({ ...base, status: 'rueckzug' })).toBe(true)
    expect(truppInField({ ...base, status: 'ueberfaellig' })).toBe(true)
  })

  it('is false before entry, after exit, or with no entry time', () => {
    expect(truppInField({ ...base, status: 'angemeldet', entryTime: '' })).toBe(false)
    expect(truppInField({ ...base, status: 'raus', exitTime: base.entryTime })).toBe(false)
    expect(truppInField({ ...base, exitTime: base.entryTime })).toBe(false) // exit set beats a stale status
    expect(truppInField({ ...base, entryTime: '' })).toBe(false)
  })

  it('anyTruppInField gates the tick: off when empty or all out, on when one is in', () => {
    expect(anyTruppInField([])).toBe(false)
    expect(anyTruppInField([{ ...base, status: 'raus', exitTime: base.entryTime }])).toBe(false)
    expect(anyTruppInField([{ ...base, status: 'angemeldet', entryTime: '' }])).toBe(false)
    expect(anyTruppInField([
      { ...base, id: 'a', status: 'raus', exitTime: base.entryTime },
      { ...base, id: 'b', status: 'aktiv' },
    ])).toBe(true)
  })
})

/* The Abschluss asks a different question than the alarm does: not «whose cylinder am I
 * watching» but «is anybody still on the record as being out there» — so a work squad counts
 * here where it deliberately does not count for the tick above. */
describe('truppStillDeployed (the Abschluss question)', () => {
  const plain: Trupp = { ...base, kind: 'einfach', entryPressureBar: 0, lowestBar: 0 }

  it('counts a Trupp that went in and never came back, Atemschutz or not', () => {
    expect(truppStillDeployed(base)).toBe(true)
    expect(truppStillDeployed({ ...base, status: 'rueckzug' })).toBe(true)
    // …and this is the one that separates it from truppInField
    expect(truppStillDeployed(plain)).toBe(true)
    expect(truppInField(plain)).toBe(false)
  })

  it('is false for one that never went in, or that was reported out', () => {
    expect(truppStillDeployed({ ...base, status: 'angemeldet', entryTime: '' })).toBe(false)
    expect(truppStillDeployed({ ...base, status: 'raus', exitTime: base.entryTime })).toBe(false)
    expect(truppStillDeployed({ ...base, exitTime: base.entryTime })).toBe(false)
  })
})

// ⚠️ 03.09.: every automatic Atemschutz row named the Truppführer and nobody else, so the
// record said «Trupp Fabich Mischa überfällig» while two people were inside — and a genuine
// one-man Trupp (Eichenberger) was indistinguishable from a pair whose second member had never
// been entered. Both printed one name.
describe('truppLogName — who a Verlauf row about this Trupp is about', () => {
  it('names the whole crew, leader first', () => {
    expect(truppLogName({ name: 'Fabich Mischa', members: ['Dürring Jan'] })).toBe('Fabich Mischa / Dürring Jan')
  })

  it('invents nobody: a Trupp with no members recorded is exactly its own name', () => {
    expect(truppLogName({ name: 'Eichenberger Bastian' })).toBe('Eichenberger Bastian')
    expect(truppLogName({ name: 'Eichenberger Bastian', members: [] })).toBe('Eichenberger Bastian')
  })

  it('does not print the Truppführer twice when the crew list repeats them', () => {
    expect(truppLogName({ name: 'Probst Tristan', members: ['Probst Tristan', 'Degen Florian'] }))
      .toBe('Probst Tristan / Degen Florian')
  })

  it('drops blanks rather than printing an empty slot', () => {
    expect(truppLogName({ name: 'Schiely Silvan', members: ['  ', 'Meier Alessandro'] }))
      .toBe('Schiely Silvan / Meier Alessandro')
    expect(truppLogName({})).toBe('')
  })

  /* ⚠️ It marks NOBODY (reverted 04.09., same day). Who leads the Trupp is real and the record
   * has to say it — but as the Gruppenführer's Funktion («AS-GF», lib/roleAssignment ·
   * truppRoleNote), which the Verlauf appends to his first mention on its own. A «GF » written
   * into this string would have arrived twice over on the same name. */
  it('writes plain names — the Gruppenführer is marked by his Funktion, not in here', () => {
    expect(truppLogName({ name: 'Brunner Thomas', members: ['Müller Hans'] }))
      .toBe('Brunner Thomas / Müller Hans')
  })
})

describe('truppNeverDeployed', () => {
  it('is true only for a closed Trupp that never went under PA', () => {
    // the Sicherungstrupp that was stood down: registered, closed, no entry
    expect(truppNeverDeployed({ ...base, status: 'raus', entryTime: '', exitTime: '2026-06-21T11:00:00Z' })).toBe(true)
  })

  it('is false for a Trupp that came out of the field, and while it is still registered', () => {
    expect(truppNeverDeployed({ ...base, status: 'raus', exitTime: '2026-06-21T11:00:00Z' })).toBe(false)
    expect(truppNeverDeployed({ ...base, status: 'angemeldet', entryTime: '' })).toBe(false)
    expect(truppNeverDeployed({ ...base, status: 'aktiv' })).toBe(false)
  })
})

// ⚠️ The second threshold, and the one half of the 27.07. decision that was reopened on purpose:
// a Trupp in Rückzug has already been told to come out, so holding it to the same turn-back
// pressure means the card warns for the whole walk back — which is how a warning stops meaning
// anything. Below the Rückzug line it speaks up again: that is a crew taking too long to get out.
describe('alarmBarFor', () => {
  const dz = { alarmBar: 100, alarmBarRueckzug: 50 }

  it('holds a working Trupp to the Alarmdruck and one on its way out to the lower line', () => {
    expect(alarmBarFor({ status: 'aktiv' }, dz)).toBe(100)
    expect(alarmBarFor({ status: 'ueberfaellig' }, dz)).toBe(100)
    expect(alarmBarFor({ status: 'rueckzug' }, dz)).toBe(50)
  })

  it('falls back to the one threshold when a station configured none', () => {
    expect(alarmBarFor({ status: 'rueckzug' }, { alarmBar: 100 })).toBe(100)
  })

  it('is what decides the cross-surface alarm, not the status alone', () => {
    const base = {
      id: 't1', name: 'Keller Anna', entryPressureBar: 300, entryTime: '2026-08-18T10:00:00Z',
      lastContactTime: new Date().toISOString(), lowestBar: 80, lastPressureBar: 80, readings: [],
    }
    const now = Date.now()
    // 80 bar: below the working line, above the Rückzug one
    const working = peakAtemschutzAlarm([{ ...base, status: 'aktiv' }], now, 5, 60, 100, 50)
    const leaving = peakAtemschutzAlarm([{ ...base, status: 'rueckzug' }], now, 5, 60, 100, 50)
    expect(working.peak).toBe(2)
    expect(working.urgent?.reason).toBe('pressure')
    expect(leaving.peak).toBe(0)
  })
})

/* ── Trupps WITHOUT Atemschutz (types · TruppKind, 03.09.) ─────────────────────────────────────
 * The board grew a second section for plain work squads. Everything in this module is about
 * cylinders and contact intervals, so none of it may apply to one — and the gate sits in exactly
 * two places (`isAtemschutzTrupp` reading the discriminator, `deriveTruppLive` refusing to start
 * a contact clock). These tests pin that the whole alarm path inherits it. */
describe('a Trupp without Atemschutz', () => {
  const plain: Trupp = { ...base, kind: 'einfach', entryPressureBar: 0, lowestBar: 0 }

  it('resolves an ABSENT kind as Atemschutz — no record written before 03.09. changes meaning', () => {
    expect(isAtemschutzTrupp(base)).toBe(true)
    expect(isAtemschutzTrupp({ kind: 'atemschutz' })).toBe(true)
    expect(isAtemschutzTrupp({ kind: 'einfach' })).toBe(false)
  })

  it('runs an Einsatzzeit but no contact clock, and can never overlay to ueberfaellig', () => {
    // an hour past the interval + Nachfrist — a PA Trupp would be überfällig long since
    const live = deriveTruppLive(plain, REF + 60 * 60_000, 5, 60)
    expect(live.elapsedSec).toBe(3600) // the row's «Einsatzzeit» still counts
    expect(live.sinceContactSec).toBeNull()
    expect(live.overdue).toBe(false)
    expect(live.status).toBe('aktiv')
    // …and the PA Trupp beside it, same times, still escalates
    expect(deriveTruppLive(base, REF + 60 * 60_000, 5, 60).status).toBe('ueberfaellig')
  })

  it('is silent in truppAlarm even at 0 bar and an hour out of contact', () => {
    const now = REF + 60 * 60_000
    const live = deriveTruppLive(plain, now, 5, 60)
    expect(truppAlarm(plain, live, 5, 60, { alarmBar: 100, alarmBarRueckzug: 50 })).toEqual({
      sev: 0, reason: null, line: null,
    })
  })

  it('never reaches the cross-surface alarm (tone, TopBar chip, NavRail dot)', () => {
    const state = peakAtemschutzAlarm([plain], REF + 60 * 60_000, 5, 60, 100, 50)
    expect(state.peak).toBe(0)
    expect(state.urgent).toBeNull()
    expect(state.severities).toEqual({})
  })

  it('does not arm the app-wide 1 Hz tick on its own', () => {
    expect(truppInField(plain)).toBe(false)
    expect(anyTruppInField([plain])).toBe(false)
    // one PA Trupp in the field is still enough to arm it
    expect(anyTruppInField([plain, base])).toBe(true)
  })
})
