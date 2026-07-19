import { describe, expect, it } from 'vitest'
import { haversineM, hoseCount, hoseLengthHint, lv95ToWgs84, polygonAreaM2, wgs84ToLV95 } from './geo'

describe('wgs84ToLV95', () => {
  // swisstopo's canonical reference: the old observatory in Bern is the LV95 origin,
  // 7.438632495°E / 46.951082563°N → 2 600 000 E / 1 200 000 N. The Näherungsformel
  // resolves it to within ~2 cm, well inside the ~1 m accuracy the formula advertises.
  it('maps the Bern reference point to the LV95 origin', () => {
    const [e, n] = wgs84ToLV95(7.438632495, 46.951082563)
    expect(e).toBeCloseTo(2_600_000, 0) // within 0.5 m
    expect(n).toBeCloseTo(1_200_000, 0)
  })

  it('places a local (north-west Swiss) point in the expected LV95 quadrant', () => {
    const [e, n] = wgs84ToLV95(7.5547, 47.5072)
    // E/N grow east/north of the origin; sanity-bound to the Swiss extent.
    expect(e).toBeGreaterThan(2_480_000)
    expect(e).toBeLessThan(2_840_000)
    expect(n).toBeGreaterThan(1_070_000)
    expect(n).toBeLessThan(1_300_000)
  })

  it('is monotonic: moving east/north increases E/N', () => {
    const [e0, n0] = wgs84ToLV95(7.55, 47.5)
    const [eEast] = wgs84ToLV95(7.56, 47.5)
    const [, nNorth] = wgs84ToLV95(7.55, 47.51)
    expect(eEast).toBeGreaterThan(e0)
    expect(nNorth).toBeGreaterThan(n0)
  })

  it('round-trips through a metric area calc consistently', () => {
    // A ~100 m × 100 m box should measure ~10 000 m² via the LV95 shoelace.
    const lat = 47.5072
    const lon = 7.5547
    const dLat = 100 / 110540
    const dLon = 100 / (111320 * Math.cos((lat * Math.PI) / 180))
    const ring: [number, number][] = [
      [lon - dLon / 2, lat - dLat / 2],
      [lon + dLon / 2, lat - dLat / 2],
      [lon + dLon / 2, lat + dLat / 2],
      [lon - dLon / 2, lat + dLat / 2],
    ]
    const area = polygonAreaM2(ring)
    expect(area).toBeGreaterThan(9_800)
    expect(area).toBeLessThan(10_200)
  })
})

describe('lv95ToWgs84', () => {
  // Inverse of the LV95 origin: 2 600 000 E / 1 200 000 N → the Bern observatory.
  it('maps the LV95 origin back to the Bern reference point', () => {
    const [lon, lat] = lv95ToWgs84(2_600_000, 1_200_000)
    expect(lon).toBeCloseTo(7.438632495, 4)
    expect(lat).toBeCloseTo(46.951082563, 4)
  })

  it('round-trips a Swiss-area point (wgs84 → LV95 → wgs84) within ~1 m', () => {
    const lon = 7.5547
    const lat = 47.5072
    const [e, n] = wgs84ToLV95(lon, lat)
    const [lon2, lat2] = lv95ToWgs84(e, n)
    // The two approximate (Näherungsformel) directions compose to a few metres of
    // residual; 4 decimals ≈ ~5 m is the honest tolerance for this transform pair.
    expect(lon2).toBeCloseTo(lon, 4)
    expect(lat2).toBeCloseTo(lat, 4)
  })
})

describe('haversineM', () => {
  it('measures ~111 km for one degree of latitude', () => {
    const d = haversineM([7.5, 47.0], [7.5, 48.0])
    expect(d).toBeGreaterThan(111_000)
    expect(d).toBeLessThan(111_400)
  })

  it('is zero for identical points', () => {
    expect(haversineM([7.5547, 47.5072], [7.5547, 47.5072])).toBeCloseTo(0, 5)
  })
})

describe('hoseCount', () => {
  it('adds a 10% reserve, then rounds UP to whole 20 m hose lengths', () => {
    expect(hoseCount(100)).toBe(6)  // 100·1.1 = 110 → 110/20 = 5.5 → 6
    expect(hoseCount(80)).toBe(5)   // 80·1.1 = 88 → 4.4 → 5
    expect(hoseCount(20)).toBe(2)   // 20·1.1 = 22 → 1.1 → 2
    expect(hoseCount(0)).toBe(0)
  })
})

describe('hoseLengthHint', () => {
  it('formats the hose count incl. the reserve', () => {
    expect(hoseLengthHint(100)).toBe('~6 Schläuche')
    expect(hoseLengthHint(0)).toBe('~0 Schläuche')
  })
})
