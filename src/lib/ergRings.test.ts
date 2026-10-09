// The Schutzabstand rings are only as good as the arithmetic under them: a mis-parsed
// "0.2 km" is a cordon drawn 200× too small. These pin the parser, the day/night pick,
// the mode column selection (incl. the 'T3' refusal) and the entity → overlay derivation.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../types'
import { appConfig } from '../config/appConfig'
import { ergDayNote, ergRingOverlays, ergRingsFor, isErgDay, parseErgDistance } from './ergRings'
import { lastSunEdge, type Coord } from './daylight'
import { formatTime } from './format'
// The ERG dataset is a fetched static asset now (lib/staticData) — inject it the way
// the boot prefetch would, so the distance rows under the rings are real.
import ergData from '../../public/erg.json'
import { __setErgData, type ErgData } from './erg'
__setErgData(ergData as unknown as ErgData)


// explicit UTC instants: the pick is the sun's, so the test machine's zone must not matter
const DAY = new Date('2026-09-07T10:00:00Z')
const NIGHT = new Date('2026-09-07T21:00:00Z')
// Oberwil BL
const OBERWIL: Coord = [7.5553, 47.5137]

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

  it('day or night is the sun at the placard, not a 07–19 h clock', () => {
    // December evening 17:30 CET: the sun set at ~16:42, so the night distance (the clock said day)
    expect(isErgDay(new Date('2026-12-15T16:30:00Z'), OBERWIL)).toBe(false)
    // December morning 07:30 CET: still dark (sunrise ~08:10)
    expect(isErgDay(new Date('2026-12-15T06:30:00Z'), OBERWIL)).toBe(false)
    // June evening 20:30 CEST: the sun is still up until ~21:30 (the clock said night)
    expect(isErgDay(new Date('2026-06-21T18:30:00Z'), OBERWIL)).toBe(true)
    // June morning 06:00 CEST: up since ~05:30
    expect(isErgDay(new Date('2026-06-21T04:00:00Z'), OBERWIL)).toBe(true)
    // midnight is night everywhere in Switzerland, midday is day
    expect(isErgDay(new Date('2026-06-21T22:00:00Z'), OBERWIL)).toBe(false)
    expect(isErgDay(new Date('2026-12-15T11:00:00Z'), OBERWIL)).toBe(true)
    // no coordinate → the national fallback, still the sun
    expect(isErgDay(new Date('2026-12-15T16:30:00Z'))).toBe(false)
  })

  it('the ring picks the night distance on a winter evening and the day one on a summer evening', () => {
    expect(ergRingsFor(row, 'small', new Date('2026-12-15T16:30:00Z'), OBERWIL)[1]).toEqual({ kind: 'protect', radiusM: 700 })
    expect(ergRingsFor(row, 'small', new Date('2026-06-21T18:30:00Z'), OBERWIL)[1]).toEqual({ kind: 'protect', radiusM: 200 })
    expect(ergRingsFor(row, 'large', new Date('2026-12-15T16:30:00Z'), OBERWIL)[1]).toEqual({ kind: 'protect', radiusM: 4700 })
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

  it('a placard marked «erledigt» keeps its rings, grey and unfilled — with the glyph (objectDone)', () => {
    const overlays = ergRingOverlays([placard({ done: { at: '2026-09-23T18:40:00.000Z' } })], DAY)
    expect(overlays).toHaveLength(2)
    for (const o of overlays) expect(o).toMatchObject({ color: appConfig.ergRings.doneColor, fillOpacity: 0 })
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

describe('ergDayNote', () => {
  it('names the horizon crossing that made it day or night', () => {
    const winterEvening = new Date('2026-12-15T16:30:00Z')
    const edge = lastSunEdge(OBERWIL, winterEvening)
    expect(edge?.kind).toBe('sunset')
    // Basel/Oberwil sunset on 15.12.: ~16:41–16:42 CET (15:41 UTC)
    expect(Math.abs(edge!.at.getTime() - Date.parse('2026-12-15T15:41:30Z'))).toBeLessThan(3 * 60_000)
    expect(ergDayNote(winterEvening, OBERWIL)).toBe(`Nacht · Sonnenuntergang ${formatTime(edge!.at)}`)

    const summerEvening = new Date('2026-06-21T18:30:00Z')
    const rise = lastSunEdge(OBERWIL, summerEvening)
    expect(rise?.kind).toBe('sunrise')
    // sunrise on 21.06.: ~05:30 CEST (03:30 UTC)
    expect(Math.abs(rise!.at.getTime() - Date.parse('2026-06-21T03:30:00Z'))).toBeLessThan(5 * 60_000)
    expect(ergDayNote(summerEvening, OBERWIL)).toBe(`Tag · Sonnenaufgang ${formatTime(rise!.at)}`)
  })

  it('says only «Tag»/«Nacht» where the sun has not crossed within 24 h (polar day/night)', () => {
    const svalbard: Coord = [19, 78] // Svalbard
    expect(lastSunEdge(svalbard, new Date('2026-06-21T12:00:00Z'))).toBeNull()
    expect(ergDayNote(new Date('2026-06-21T12:00:00Z'), svalbard)).toBe('Tag')
    expect(ergDayNote(new Date('2026-12-21T12:00:00Z'), svalbard)).toBe('Nacht')
  })
})
