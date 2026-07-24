import { describe, expect, it } from 'vitest'
import {
  deriveAusgerueckt, fahrzeugRows, gruppenRows, setFahrzeugZeit, setGruppeZeit,
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
