// The Schutzabstand rings are only as good as the arithmetic under them: a mis-parsed
// "0.2 km" is a cordon drawn 200× too small. These pin the parser, the day/night pick,
// the mode column selection (incl. the 'T3' refusal) and the entity → overlay derivation.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../types'
import { appConfig } from '../config/appConfig'
import { ergCorridorRing, ergDayNote, ergRingOverlays, ergRingsFor, ergWind, ergWindNotes, ergWindShiftAhead, isErgDay, parseErgDistance } from './ergRings'
import { parseWeatherTime } from './weatherTime'
import type { LngLat, WeatherData } from '../types'
import { haversineM } from './geo'
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

// ── F4 (09.10.2026): the protective distance as a downwind oval ─────────────────────────────

/** compass bearing a → b in the same flat local metres the ring is built in */
const bearing = (a: LngLat, b: LngLat) => {
  const east = (b[0] - a[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180)
  const north = (b[1] - a[1]) * 110540
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
}

const wx = (over: Partial<WeatherData> = {}): WeatherData => ({
  wind_dir_deg: 270, wind_speed_kmh: 14, wind_gust_kmh: null, temp_c: 12, precip_mm: 0, weather_code: 2,
  // 8 min before DAY — a fresh MeteoSwiss reading
  observed_at: '2026-09-07T09:52:00+00:00', source: 'meteoswiss', station: 'Basel / Binningen',
  ...over,
})

describe('ergCorridorRing', () => {
  const O: LngLat = [7.55, 47.51]

  it('starts at the placard and reaches the distance along the bearing the wind blows TO', () => {
    for (const to of [0, 90, 225, 300]) {
      const ring = ergCorridorRing(O, to, 1500, 750, 72)
      expect(haversineM(ring[0], O)).toBeLessThan(0.5)
      const tip = ring[36]
      expect(Math.abs(haversineM(O, tip) - 1500)).toBeLessThan(10)
      expect(Math.abs(bearing(O, tip) - to) % 360).toBeLessThan(0.5)
      // closed, for the GeoJSON polygon
      expect(haversineM(ring[0], ring[72])).toBeLessThan(0.01)
    }
  })

  it('is the configured width across its middle, symmetric about the wind axis', () => {
    const ring = ergCorridorRing(O, 90, 1000, 500, 72)
    const left = ring[54]
    const right = ring[18]
    expect(Math.abs(haversineM(left, right) - 500)).toBeLessThan(3)
    // both halfway down the corridor (east of the placard by 500 m), one north, one south
    expect(Math.abs(haversineM(O, [left[0], O[1]]) - 500)).toBeLessThan(3)
    expect(left[1] > O[1]).not.toBe(right[1] > O[1])
  })
})

describe('ergWind', () => {
  it('a fresh wind with some strength aims the corridor; the plume goes where the wind blows to', () => {
    expect(ergWind(wx(), DAY)).toMatchObject({ ok: true, fromDeg: 270, toDeg: 90, speedKmh: 14, source: 'meteoswiss' })
    expect(ergWind(wx({ wind_dir_deg: 45 }), DAY)).toMatchObject({ ok: true, toDeg: 225 })
  })

  it('no reading, no direction or no speed → none', () => {
    expect(ergWind(null, DAY)).toMatchObject({ ok: false, reason: 'none' })
    expect(ergWind(undefined, DAY)).toMatchObject({ ok: false, reason: 'none' })
    expect(ergWind(wx({ wind_dir_deg: null }), DAY)).toMatchObject({ ok: false, reason: 'none' })
    expect(ergWind(wx({ wind_speed_kmh: null }), DAY)).toMatchObject({ ok: false, reason: 'none' })
  })

  it('calm: a breeze under the threshold has no direction worth drawing', () => {
    expect(ergWind(wx({ wind_speed_kmh: appConfig.ergRings.windCalmBelowKmh - 0.5 }), DAY)).toMatchObject({ ok: false, reason: 'calm' })
    expect(ergWind(wx({ wind_speed_kmh: appConfig.ergRings.windCalmBelowKmh }), DAY).ok).toBe(true)
  })

  it('stale: older than windStaleMin, or with no time to prove it is current', () => {
    const min = appConfig.ergRings.windStaleMin
    const at = (m: number) => new Date(DAY.getTime() - m * 60_000).toISOString()
    expect(ergWind(wx({ observed_at: at(min - 1) }), DAY).ok).toBe(true)
    expect(ergWind(wx({ observed_at: at(min + 1) }), DAY)).toMatchObject({ ok: false, reason: 'stale' })
    expect(ergWind(wx({ observed_at: null }), DAY)).toMatchObject({ ok: false, reason: 'stale', at: null })
    // a reading AHEAD of the device clock is skew, not staleness
    expect(ergWind(wx({ observed_at: at(-5) }), DAY).ok).toBe(true)
  })

  it('reads an Open-Meteo stamp without a zone as UTC, not as device-local time', () => {
    expect(parseWeatherTime('2026-09-07T09:45')?.toISOString()).toBe('2026-09-07T09:45:00.000Z')
    expect(parseWeatherTime('2026-09-07T09:45:00+02:00')?.toISOString()).toBe('2026-09-07T07:45:00.000Z')
    expect(parseWeatherTime('garbage')).toBeNull()
    expect(ergWind(wx({ observed_at: '2026-09-07T09:45', source: 'open-meteo', station: null }), DAY).ok).toBe(true)
  })
})

describe('ergRingOverlays · downwind oval', () => {
  // UN 1017 (Chlor): isolation 60 m, protective 0.3 km by day, 1.5 km by night
  const chlor: Entity = { id: 'c1', kind: 'symbol', layer: 'taktisch', coord: [7.55, 47.51], symbol: appConfig.symbols.placardName, fields: { 'UN-Nr.': '1017' } }

  it('the protective ring becomes an oval downwind, as long as the DAY distance; isolation stays a circle', () => {
    const [iso, prot] = ergRingOverlays([chlor], DAY, wx())
    expect(iso).toMatchObject({ id: 'erg-c1-isolation', kind: 'circle', radiusM: 60 })
    expect(prot).toMatchObject({ id: 'erg-c1-protect', kind: 'polygon', layer: 'taktisch', lineDasharray: [2, 2], fillOpacity: 0 })
    if (prot.kind !== 'polygon') throw new Error('not an oval')
    const tip = prot.coords[Math.floor(prot.coords.length / 2)]
    expect(Math.abs(haversineM(chlor.coord!, tip) - 300)).toBeLessThan(3)
    // wind FROM the west → the plume runs east
    expect(Math.abs(bearing(chlor.coord!, tip) - 90)).toBeLessThan(0.5)
  })

  it('…and as long as the NIGHT distance at night', () => {
    const night = new Date('2026-09-07T21:00:00Z')
    const prot = ergRingOverlays([chlor], night, wx({ observed_at: '2026-09-07T20:50:00Z', wind_dir_deg: 180 }))[1]
    if (prot.kind !== 'polygon') throw new Error('not an oval')
    const tip = prot.coords[Math.floor(prot.coords.length / 2)]
    expect(Math.abs(haversineM(chlor.coord!, tip) - 1500)).toBeLessThan(10)
    // wind FROM the south → north
    expect(Math.min(bearing(chlor.coord!, tip), 360 - bearing(chlor.coord!, tip))).toBeLessThan(0.5)
  })

  it('falls back to the full circle without a usable wind (none, calm, stale)', () => {
    const shapeOf = (w: WeatherData | null | undefined) => ergRingOverlays([chlor], DAY, w)[1]
    expect(shapeOf(undefined)).toMatchObject({ kind: 'circle', radiusM: 300 })
    expect(shapeOf(null)).toMatchObject({ kind: 'circle', radiusM: 300 })
    expect(shapeOf(wx({ wind_speed_kmh: 2 }))).toMatchObject({ kind: 'circle', radiusM: 300 })
    expect(shapeOf(wx({ observed_at: '2026-09-07T08:00:00Z' }))).toMatchObject({ kind: 'circle', radiusM: 300 })
  })

  it('a placard marked «erledigt» keeps its oval grey and unfilled', () => {
    const prot = ergRingOverlays([{ ...chlor, done: { at: '2026-09-07T09:55:00Z' } }], DAY, wx())[1]
    expect(prot).toMatchObject({ kind: 'polygon', color: appConfig.ergRings.doneColor, fillOpacity: 0 })
  })
})

describe('ergWindShiftAhead', () => {
  // DAY is 10:00 UTC; the model says 270° now, the station measures 270°
  const fc = (rows: [string, number | null, number | null][]) => wx({ wind_forecast: rows.map(([at, dir_deg, speed_kmh]) => ({ at, dir_deg, speed_kmh })) })
  const at40 = new Date('2026-09-07T10:20:00Z') // the 11:00 hour is 40′ away

  it('names a significant turn due within two hours, against the model\'s own current hour', () => {
    const w = fc([['2026-09-07T10:00', 270, 12], ['2026-09-07T11:00', 330, 12], ['2026-09-07T12:00', 335, 14]])
    expect(ergWindShiftAhead({ ...w, observed_at: '2026-09-07T10:12:00Z' }, at40)).toEqual({ fromDeg: 330, inMin: 40 })
  })

  it('stays quiet for a small turn, a turn beyond two hours, a calm hour, or no forecast', () => {
    expect(ergWindShiftAhead(fc([['2026-09-07T10:00', 270, 12], ['2026-09-07T11:00', 300, 12]]), DAY)).toBeNull()
    expect(ergWindShiftAhead(fc([['2026-09-07T10:00', 270, 12], ['2026-09-07T12:00', 270, 12], ['2026-09-07T13:00', 90, 12]]), DAY)).toBeNull()
    expect(ergWindShiftAhead(fc([['2026-09-07T10:00', 270, 12], ['2026-09-07T11:00', 90, 2]]), DAY)).toBeNull()
    expect(ergWindShiftAhead(wx(), DAY)).toBeNull()
    expect(ergWindShiftAhead(wx({ wind_forecast: null }), DAY)).toBeNull()
  })

  it('never announces a turn to where the measured wind already blows', () => {
    // the model lags: it says 200° now and 270° next hour, but the station already measures 270°
    expect(ergWindShiftAhead(fc([['2026-09-07T10:00', 200, 12], ['2026-09-07T11:00', 270, 12]]), DAY)).toBeNull()
  })
})

describe('ergWindNotes', () => {
  it('oval: what is drawn, the wind that aimed it (source, station, time) and the assumption', () => {
    const notes = ergWindNotes(wx(), DAY)
    expect(notes.shape).toBe('oval')
    const t = formatTime(new Date('2026-09-07T09:52:00Z'))
    expect(notes.lines[0]).toBe(`Schutzabstand als Oval nach O – Wind aus W (270°), 14 km/h · MeteoSchweiz Basel / Binningen ${t}`)
    expect(notes.lines[1]).toContain('Breite 50 %')
    expect(notes.lines[1]).toContain('Planungshilfe / Schätzung')
    expect(notes.lines).toHaveLength(2)
  })

  it('adds the forecast turn when one is due', () => {
    const w = wx({ observed_at: '2026-09-07T10:12:00Z', wind_forecast: [{ at: '2026-09-07T10:00', dir_deg: 270, speed_kmh: 12 }, { at: '2026-09-07T11:00', dir_deg: 315, speed_kmh: 12 }] })
    expect(ergWindNotes(w, new Date('2026-09-07T10:20:00Z')).lines[2]).toBe('Prognose: Wind dreht auf NW (315°) in ~40′')
  })

  it('circle: says why', () => {
    expect(ergWindNotes(null, DAY)).toEqual({ shape: 'circle', lines: ['Schutzabstand als Kreis – kein Wind gemeldet'] })
    expect(ergWindNotes(wx({ wind_speed_kmh: 3 }), DAY).lines[0]).toMatch(/^Schutzabstand als Kreis – Wind schwach \(3 km\/h\), Richtung unsicher · MeteoSchweiz/)
    expect(ergWindNotes(wx({ observed_at: '2026-09-07T08:00:00Z' }), DAY).lines[0]).toMatch(/^Schutzabstand als Kreis – Windmessung veraltet · MeteoSchweiz Basel \/ Binningen /)
    expect(ergWindNotes(wx({ observed_at: null }), DAY).lines[0]).toBe('Schutzabstand als Kreis – Windmessung ohne Zeitangabe')
  })
})
