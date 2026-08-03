import { describe, expect, it } from 'vitest'
import { ABSCHLUSS_STEPS, applyTimeToIso, isoOnDay, missingSteps, stepDone, type AbschlussFacts, keepEndAfterStart, keepStartBeforeEnd } from './abschluss'

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

  // One of the four Mindestangaben, and the one that went unchecked until 2026-08-03: a
  // rapport could close with nobody named as having led the incident.
  it('einsatzleiter needs a non-blank name', () => {
    expect(stepDone('einsatzleiter', facts())).toBe(false)
    expect(stepDone('einsatzleiter', facts({ reportMeta: { einsatzleiter: '  ' } }))).toBe(false)
    expect(stepDone('einsatzleiter', facts({ reportMeta: { einsatzleiter: 'Hptm Meier' } }))).toBe(true)
  })

  it('missingSteps lists everything open, in step order', () => {
    expect(missingSteps(facts())).toEqual(ABSCHLUSS_STEPS)
    const done = facts({
      reportMeta: {
        endedAt: '2026-07-08T05:00:00Z', summary: 'ok', mittelConfirmedNone: true,
        einsatzleiter: 'Hptm Meier',
      },
      attendanceCount: 3,
    })
    expect(missingSteps(done)).toEqual([])
  })

  // The Mindestangaben are a closing gate, not a printing gate: the sheet's own rule is that
  // whatever is still empty prints as a blank line to fill in by hand.
  it('a rapport missing only the Einsatzleiter names exactly that', () => {
    const m = missingSteps(facts({
      reportMeta: { endedAt: '2026-07-08T05:00:00Z', summary: 'ok', mittelConfirmedNone: true },
      attendanceCount: 3,
    }))
    expect(m).toEqual(['einsatzleiter'])
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

  // The pull-forward above keeps a start within 24h of its end, which is right for ONE night and
  // wrong for anything longer. On an Elementarereignis a 58-hour presence lost a whole day to it:
  // the correction looked like it worked and the Rapport was ~24 hours short, with no warning.
  it('does not swallow a day when correcting inside a multi-day stretch', () => {
    const from = iso('2026-07-28T08:00:00')
    const to = iso('2026-07-30T18:00:00')
    const out = applyTimeToIso(from, '09:00', { prevDayIfAfter: to })
    expect(new Date(out!).getDate()).toBe(28)
    expect(new Date(out!).getHours()).toBe(9)
  })

  it('still pulls a start back inside a multi-day stretch when it is typed past the end', () => {
    // the reversed-block guard has to keep working even on a long span
    const from = iso('2026-07-28T08:00:00')
    const to = iso('2026-07-30T18:00:00')
    const out = applyTimeToIso(from, '19:00', { prevDayIfAfter: to })
    expect(Date.parse(out!)).toBeLessThan(Date.parse(to))
  })
})

// Once the picker can SAY which day, nothing has to be inferred — this is the path that makes the
// multi-day case exact rather than merely non-destructive.
describe('isoOnDay — a time placed on a day the operator chose', () => {
  it('puts the clock on that calendar day, ignoring any earlier stamp', () => {
    const out = isoOnDay(new Date(2026, 6, 30), '09:00')
    const d = new Date(out!)
    expect(d.getDate()).toBe(30)
    expect(d.getMonth()).toBe(6)
    expect(d.getHours()).toBe(9)
  })

  it('refuses gibberish rather than inventing a time', () => {
    expect(isoOnDay(new Date(2026, 6, 30), '99:99')).toBeNull()
    expect(isoOnDay(new Date(NaN), '09:00')).toBeNull()
  })
})

describe('an end can never land before its start', () => {
  const iso = (d: string) => new Date(d).toISOString()

  it('steps the DAY forward and keeps the clock the operator picked', () => {
    // the day wheel bypassed applyTimeToIso's overnight roll: «bis» could be set a day BEFORE
    // «von», and a reversed stretch draws as nothing, counts zero minutes and hides in the sheet
    const from = iso('2026-07-28T20:00')
    const to = iso('2026-07-27T06:00') // a day too early
    const fixed = new Date(keepEndAfterStart(from, to))
    expect(fixed.getHours()).toBe(6)          // the clock is untouched
    expect(fixed.getDate()).toBe(29)          // only the day moved, and only as far as it had to
  })

  it('leaves an end that is already after its start alone', () => {
    const from = iso('2026-07-28T07:00')
    const to = iso('2026-07-28T12:00')
    expect(keepEndAfterStart(from, to)).toBe(to)
  })

  it('rolls a same-clock end to the next day rather than making it zero minutes', () => {
    const from = iso('2026-07-28T07:00')
    expect(new Date(keepEndAfterStart(from, from)).getDate()).toBe(29)
  })

  it('steps a start BACK when it was set after its own end', () => {
    const from = iso('2026-07-29T22:00')
    const to = iso('2026-07-29T06:00')
    const fixed = new Date(keepStartBeforeEnd(from, to))
    expect(fixed.getHours()).toBe(22)
    expect(fixed.getDate()).toBe(28)
  })

  it('gives an unreadable stamp back unchanged rather than inventing one', () => {
    expect(keepEndAfterStart('nonsense', 'also nonsense')).toBe('also nonsense')
  })
})
