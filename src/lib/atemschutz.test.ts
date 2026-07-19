import { describe, expect, it } from 'vitest'
import { anyTruppInField, contactSeverity, deriveTruppLive, fmtClock, peakAtemschutzAlarm, truppInField } from './atemschutz'
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

describe('fmtClock', () => {
  it('formats seconds as m:ss and handles unknown', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(600)).toBe('10:00')
    expect(fmtClock(null)).toBe('–:––')
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
    expect(peakAtemschutzAlarm([at(1)], REF, 5, 60)).toEqual({ peak: 0, urgent: null })
    expect(peakAtemschutzAlarm([], REF, 5, 60)).toEqual({ peak: 0, urgent: null })
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
