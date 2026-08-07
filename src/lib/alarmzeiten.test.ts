import { describe, expect, it } from 'vitest'
import {
  deriveAusgerueckt, fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit, zeitFromClock, zeitIssues,
} from './alarmzeiten'
import type { AlarmGroup, FleetVehicle } from './deploymentConfig'

const GROUPS: AlarmGroup[] = [
  { id: 'g2', label: 'Gr. 2', color: 'Rot' },
  { id: 'tgp', label: 'Gr. 9', tagespikett: true },
]
const VEHICLES: FleetVehicle[] = [{ id: 'tlf', label: 'TLF' }, { id: 'pio', label: 'Pio' }]

describe('deriveAusgerueckt', () => {
  it('is the FIRST physical departure (min of vehicle times)', () => {
    expect(deriveAusgerueckt([
      { id: 'pio', ausgerueckt: '2026-07-13T01:20:00Z' },
      { id: 'tlf', ausgerueckt: '2026-07-13T01:16:40Z' },
      { id: 'x', vorOrt: '2026-07-13T01:10:00Z' }, // vorOrt alone is not a departure
    ])).toBe('2026-07-13T01:16:40Z')
  })
  it('null without vehicle data → the manual field stays authoritative', () => {
    expect(deriveAusgerueckt(undefined)).toBeNull()
    expect(deriveAusgerueckt([{ id: 'tlf' }])).toBeNull()
  })
})

describe('manual edits', () => {
  it('setGruppeZeit stamps manual and clearing removes the entry', () => {
    const one = setGruppeZeit(undefined, 'g2', '2026-07-13T01:12:00Z')
    expect(one).toEqual([{ id: 'g2', alarmedAt: '2026-07-13T01:12:00Z', manual: true }])
    expect(setGruppeZeit(one, 'g2', null)).toEqual([])
  })
  it('setFahrzeugZeit edits one field, keeps the others, drops empty rows', () => {
    let l = setFahrzeugZeit(undefined, 'tlf', 'ausgerueckt', '2026-07-13T01:16:00Z')
    l = setFahrzeugZeit(l, 'tlf', 'vorOrt', '2026-07-13T01:22:00Z')
    expect(l).toEqual([{ id: 'tlf', ausgerueckt: '2026-07-13T01:16:00Z', vorOrt: '2026-07-13T01:22:00Z', manual: true }])
    l = setFahrzeugZeit(l, 'tlf', 'vorOrt', null)
    expect(l[0].vorOrt).toBeUndefined()
    expect(setFahrzeugZeit(l, 'tlf', 'ausgerueckt', null)).toEqual([])
  })
})

describe('grid rows', () => {
  it('config order first, unmatched webhook ids appended — never dropped', () => {
    const rows = gruppenRows(GROUPS, [{ id: 'geist', alarmedAt: '2026-07-13T01:00:00Z' }, { id: 'tgp', alarmedAt: '2026-07-13T01:01:00Z' }])
    expect(rows.map((r) => r.config.id)).toEqual(['g2', 'tgp', 'geist'])
    expect(rows[1].value?.alarmedAt).toBe('2026-07-13T01:01:00Z')
    const vrows = fahrzeugRows(VEHICLES, [{ id: 'unimog', ausgerueckt: '2026-07-13T01:05:00Z' }])
    expect(vrows.map((r) => r.config.label)).toEqual(['TLF', 'Pio', 'UNIMOG'])
  })
})

describe('zeitIssues — the clocks warn, they never block', () => {
  const NOW = Date.parse('2026-08-06T12:00:00Z')
  const alarm = '2026-08-06T09:00:00Z'
  const aus = '2026-08-06T09:06:00Z'

  it('says nothing about a normal Einsatz', () => {
    expect(zeitIssues({ alarmiertAt: alarm, ausgeruecktAt: aus, endedAt: '2026-08-06T11:00:00Z' }, NOW)).toEqual([])
  })

  it('flags an Ende before the Ausrücken and names what it contradicts', () => {
    // the reported case: a mistyped year reads as an ordinary date in a one-line field
    const out = zeitIssues({ alarmiertAt: alarm, ausgeruecktAt: aus, endedAt: '2025-06-04T11:00:00Z' }, NOW)
    expect(out).toEqual([{ kind: 'ende', code: 'beforeAusgerueckt', ref: aus }])
  })

  it('falls back to the alarm when there is no Ausrückzeit', () => {
    expect(zeitIssues({ alarmiertAt: alarm, endedAt: '2026-08-06T08:00:00Z' }, NOW))
      .toEqual([{ kind: 'ende', code: 'beforeAlarm', ref: alarm }])
  })

  it('does not say the same thing twice', () => {
    // before the Ausrücken AND before the alarm — only the most specific one is worth reading
    const out = zeitIssues({ alarmiertAt: alarm, ausgeruecktAt: aus, endedAt: '2026-08-05T10:00:00Z' }, NOW)
    expect(out.filter((i) => i.kind === 'ende')).toHaveLength(1)
  })

  it('flags an Ausrücken before the alarm', () => {
    expect(zeitIssues({ alarmiertAt: alarm, ausgeruecktAt: '2026-08-06T08:00:00Z' }, NOW))
      .toContainEqual({ kind: 'ausgerueckt', code: 'beforeAlarm', ref: alarm })
  })

  it('flags a stamp in the future, but tolerates «jetzt» and a drifting tablet clock', () => {
    expect(zeitIssues({ endedAt: '2026-08-06T12:02:00Z' }, NOW)).toEqual([])       // 2 min — clock drift
    expect(zeitIssues({ endedAt: '2026-08-06T14:00:00Z' }, NOW))
      .toEqual([{ kind: 'ende', code: 'future' }])
  })

  it('ignores empty and unparseable stamps rather than inventing a warning', () => {
    expect(zeitIssues({}, NOW)).toEqual([])
    expect(zeitIssues({ alarmiertAt: 'keine Zeit', endedAt: '2026-08-06T11:00:00Z' }, NOW)).toEqual([])
    // an Einsatz over midnight is legitimate and must stay silent
    expect(zeitIssues({ alarmiertAt: '2026-08-05T23:40:00Z', endedAt: '2026-08-06T01:20:00Z' }, NOW)).toEqual([])
  })
})

// The Einsatz that starts at 23:50: every clock in the grid is a bare HH:MM, so the calendar day
// has to be inferred, and inferring «the alarm's own day» put the Ausrückzeit 23h35 BEFORE the
// alarm — wrong date on the printed rapport, and zeitIssues warning `beforeAlarm` on an entry
// that was right all along.
describe('zeitFromClock — the Einsatz that runs over midnight', () => {
  const local = (s: string) => new Date(s).toISOString()
  const ALARM = local('2026-08-06T23:50:00')

  it('puts an Ausrückzeit of 00:15 on the NEXT day, after the alarm', () => {
    const out = zeitFromClock(ALARM, '00:15')
    expect(out).not.toBeNull()
    const d = new Date(out!)
    expect(d.getDate()).toBe(7)
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 15])
    expect(Date.parse(out!)).toBeGreaterThan(Date.parse(ALARM))
  })

  it('raises no beforeAlarm issue on that Ausrückzeit', () => {
    const fahrzeuge = setFahrzeugZeit([], 'tlf', 'ausgerueckt', zeitFromClock(ALARM, '00:15'))
    const ausgerueckt = deriveAusgerueckt(fahrzeuge)
    const now = Date.parse(local('2026-08-07T09:00:00'))
    expect(zeitIssues({ alarmiertAt: ALARM, ausgeruecktAt: ausgerueckt }, now)).toEqual([])
  })

  it('leaves a time later the same evening on the alarm day', () => {
    const out = zeitFromClock(ALARM, '23:55')
    expect(new Date(out!).getDate()).toBe(6)
  })

  it('takes the day wheel literally when the operator moved it — day three of an Elementarereignis', () => {
    // the escape from a single roll: 07:30 on the 9th cannot be reached by inference at all
    const out = zeitFromClock(ALARM, '07:30', new Date(2026, 7, 9))
    const d = new Date(out!)
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([9, 7, 30])
  })

  it('reads an empty clock as «remove the entry», not as a stamp', () => {
    expect(zeitFromClock(ALARM, '')).toBeNull()
    expect(setGruppeZeit([{ id: 'g2', alarmedAt: ALARM }], 'g2', zeitFromClock(ALARM, ''))).toEqual([])
  })
})
