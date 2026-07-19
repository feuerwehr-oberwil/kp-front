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
