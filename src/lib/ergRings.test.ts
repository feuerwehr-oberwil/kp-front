// The Schutzabstand rings are only as good as the arithmetic under them: a mis-parsed
// "0.2 km" is a cordon drawn 200× too small. These pin the parser, the day/night pick,
// the mode column selection (incl. the 'T3' refusal) and the entity → overlay derivation.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../types'
import { appConfig } from '../config/appConfig'
import { ergRingOverlays, ergRingsFor, isErgDay, parseErgDistance } from './ergRings'
// The ERG dataset is a fetched static asset now (lib/staticData) — inject it the way
// the boot prefetch would, so the distance rows under the rings are real.
import ergData from '../../public/erg.json'
import { __setErgData, type ErgData } from './erg'
__setErgData(ergData as unknown as ErgData)


const DAY = new Date('2026-09-07T12:00:00')
const NIGHT = new Date('2026-09-07T23:00:00')

describe('parseErgDistance', () => {
  it('reads metres and kilometres into metres', () => {
    expect(parseErgDistance('30 m')).toBe(30)
    expect(parseErgDistance('0.2 km')).toBe(200)
    // the one irregular value in ERG2024 ("11.0+ km (7.0+ mi)") keeps its number
    expect(parseErgDistance('11.0+ km (7.0+ mi)')).toBe(11000)
  })

  it('refuses what is not a distance', () => {
    expect(parseErgDistance(undefined)).toBeNull()
    expect(parseErgDistance('T3')).toBeNull()
  })
})

describe('ergRingsFor', () => {
  const row = { si: '60 m', pd: '0.2 km', pn: '0.7 km', l: { li: '400 m', ld: '2.4 km', ln: '4.7 km' } }

  it('the day window switches exactly at 07:00 and 19:00', () => {
    expect(isErgDay(new Date('2026-09-07T06:59:00'))).toBe(false)
    expect(isErgDay(new Date('2026-09-07T07:00:00'))).toBe(true)
    expect(isErgDay(new Date('2026-09-07T18:59:00'))).toBe(true)
    expect(isErgDay(new Date('2026-09-07T19:00:00'))).toBe(false)
  })

  it('small spill: isolation plus the protective distance of the current half-day', () => {
    expect(isErgDay(DAY)).toBe(true)
    expect(ergRingsFor(row, 'small', DAY)).toEqual([
      { kind: 'isolation', radiusM: 60 },
      { kind: 'protect', radiusM: 200 },
    ])
    expect(ergRingsFor(row, 'small', NIGHT)[1]).toEqual({ kind: 'protect', radiusM: 700 })
  })

  it('large spill reads the large column — and refuses the T3 sentinel', () => {
    expect(ergRingsFor(row, 'large', DAY)).toEqual([
      { kind: 'isolation', radiusM: 400 },
      { kind: 'protect', radiusM: 2400 },
    ])
    expect(ergRingsFor({ ...row, l: 'T3' as const }, 'large', DAY)).toEqual([])
  })

  it("'off' and a missing row draw nothing", () => {
    expect(ergRingsFor(row, 'off', DAY)).toEqual([])
    expect(ergRingsFor(undefined, 'small', DAY)).toEqual([])
  })
})

describe('ergRingOverlays', () => {
  const placard = (over: Partial<Entity> = {}): Entity => ({
    id: 'p1', kind: 'symbol', layer: 'taktisch', coord: [7.55, 47.51],
    symbol: appConfig.symbols.placardName,
    // UN 1008 (Bortrifluorid) carries a full TIH row in the bundled ERG2024 data
    fields: { 'UN-Nr.': '1008', Stoff: 'BORTRIFLUORID' },
    ...over,
  })

  it('a placard with a TIH substance earns its rings by default, on its own layer', () => {
    const overlays = ergRingOverlays([placard()], DAY)
    expect(overlays.map((o) => o.id)).toEqual(['erg-p1-isolation', 'erg-p1-protect'])
    expect(overlays[0]).toMatchObject({ kind: 'circle', layer: 'taktisch', center: [7.55, 47.51], radiusM: 30 })
  })

  it('tolerates the legacy dotless field key, like the panel does', () => {
    expect(ergRingOverlays([placard({ fields: { 'UN-Nr': '1008' } })], DAY)).toHaveLength(2)
  })

  it('the Gas/Chemie hazard symbols earn rings too (UN_CAPABLE, not just the Tafel)', () => {
    // UN 1017 (Chlor) — one of the FW Gefahr G commons, with a full TIH row
    const gas = placard({ symbol: 'FW Gefahr G', fields: { Stoff: 'Chlor', 'UN-Nr.': '1017' } })
    expect(ergRingOverlays([gas], DAY).map((o) => o.id)).toEqual(['erg-p1-isolation', 'erg-p1-protect'])
  })

  it("draws nothing for 'off', for other symbols, and for a UN without TIH data", () => {
    expect(ergRingOverlays([placard({ ergRings: 'off' })], DAY)).toEqual([])
    expect(ergRingOverlays([placard({ symbol: 'VKF Feuer' })], DAY)).toEqual([])
    // UN 1203 (petrol) has a guide but no TIH table
    expect(ergRingOverlays([placard({ fields: { 'UN-Nr.': '1203' } })], DAY)).toEqual([])
  })
})
