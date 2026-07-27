import { describe, expect, it } from 'vitest'
import { ABSCHLUSS_STEPS, applyTimeToIso, missingSteps, stepDone, type AbschlussFacts } from './abschluss'

const facts = (over: Partial<AbschlussFacts> = {}): AbschlussFacts => ({
  reportMeta: {},
  attendanceCount: 0,
  mittelCount: 0,
  ...over,
})

describe('stepDone', () => {
  it('zeiten needs the Einsatzende', () => {
    expect(stepDone('zeiten', facts())).toBe(false)
    expect(stepDone('zeiten', facts({ reportMeta: { endedAt: '2026-07-08T05:00:00Z' } }))).toBe(true)
  })

  it('mittel: entries OR the explicit «nichts verwendet» confirmation — never silence', () => {
    expect(stepDone('mittel', facts())).toBe(false)
    expect(stepDone('mittel', facts({ mittelCount: 2 }))).toBe(true)
    expect(stepDone('mittel', facts({ reportMeta: { mittelConfirmedNone: true } }))).toBe(true)
  })

  it('abschluss needs a non-blank Zusammenfassung', () => {
    expect(stepDone('abschluss', facts({ reportMeta: { summary: '   ' } }))).toBe(false)
    expect(stepDone('abschluss', facts({ reportMeta: { summary: 'BMA, Fehlalarm.' } }))).toBe(true)
  })

  it('missingSteps lists everything open, in step order', () => {
    expect(missingSteps(facts())).toEqual(ABSCHLUSS_STEPS)
    const done = facts({
      reportMeta: { endedAt: '2026-07-08T05:00:00Z', summary: 'ok', mittelConfirmedNone: true },
      attendanceCount: 3,
    })
    expect(missingSteps(done)).toEqual([])
  })
})

describe('applyTimeToIso', () => {
  it('replaces the wall-clock time, keeping the calendar day', () => {
    const out = applyTimeToIso('2026-07-08T03:12:00', '04:30')
    expect(out).not.toBeNull()
    const d = new Date(out as string)
    expect([d.getHours(), d.getMinutes()]).toEqual([4, 30])
    expect(d.getDate()).toBe(8)
  })

  it('rolls past midnight when the result would precede the von time', () => {
    const von = applyTimeToIso('2026-07-08T22:00:00', '22:00') as string
    const bis = applyTimeToIso('2026-07-08T22:00:00', '01:30', { nextDayIfBefore: von }) as string
    expect(new Date(bis).getTime()).toBeGreaterThan(new Date(von).getTime())
    expect(new Date(bis).getDate()).toBe(9)
  })

  it('rejects garbage', () => {
    expect(applyTimeToIso('2026-07-08T03:12:00Z', '99x')).toBeNull()
    expect(applyTimeToIso('not-a-date', '04:30')).toBeNull()
  })
})


describe('applyTimeToIso — prevDayIfAfter (the «von» mirror)', () => {
  const iso = (s: string) => new Date(s).toISOString()

  it('pulls a start typed after its own end back to the previous day', () => {
    // block 00:15 → 01:30; the operator corrects «von» to 23:45, meaning the night before
    const out = applyTimeToIso(iso('2026-07-27T00:15:00'), '23:45', { prevDayIfAfter: iso('2026-07-27T01:30:00') })
    expect(new Date(out!).getDate()).toBe(26)
  })

  it('does NOT invent a 25-hour block when correcting inside an already-overnight one', () => {
    // block 26th 22:00 → 27th 01:30. Correcting «von» to 00:30 means the 27th — one hour.
    // Stepping back unconditionally produced 25 hours, which looks normal and reaches the Rapport.
    const to = iso('2026-07-27T01:30:00')
    const out = applyTimeToIso(iso('2026-07-26T22:00:00'), '00:30', { prevDayIfAfter: to })
    const mins = (Date.parse(to) - Date.parse(out!)) / 60_000
    expect(mins).toBe(60)
  })

  it('leaves a plain same-day correction alone', () => {
    const out = applyTimeToIso(iso('2026-07-27T14:00:00'), '13:00', { prevDayIfAfter: iso('2026-07-27T18:00:00') })
    expect(new Date(out!).getDate()).toBe(27)
    expect(new Date(out!).getHours()).toBe(13)
  })
})
