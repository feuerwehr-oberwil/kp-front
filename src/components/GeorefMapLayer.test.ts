// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { loupeCrop, loupePaint } from './GeorefMapLayer'

/** Oberwil BL, roughly the Feuerwehrmagazin — a real deep-zoom crop, not a synthetic one. */
const LNG = 7.5617
const LAT = 47.4967

describe('the map loupe crop', () => {
  // ⚠️ THE regression. A browser clamps a CSS transform translation at ±2²⁵ px, and at z 20 a
  // world-pixel coordinate is ~1.4e8: the plane silently moved a hundred million pixels short,
  // the tiles ended up off-screen and the magnifier was a permanently empty circle with four
  // perfectly loaded tiles inside it. Every coordinate must stay tile-relative.
  const CLAMP = 2 ** 25
  it('keeps every coordinate far inside the browser transform clamp, even at z 20', () => {
    for (const z of [12, 16, 19, 20]) {
      const crop = loupeCrop('https://t/{z}/{x}/{y}.png', LNG, LAT, z, 1, 148)
      expect(Math.abs(crop.dx)).toBeLessThan(1024)
      expect(Math.abs(crop.dy)).toBeLessThan(1024)
      for (const t of crop.tiles) {
        expect(Math.abs(t.left)).toBeLessThan(CLAMP)
        expect(Math.abs(t.top)).toBeLessThan(CLAMP)
      }
    }
  })

  it('covers the aimed point: the crop slides it inside the first tile', () => {
    const crop = loupeCrop('https://t/{z}/{x}/{y}.png', LNG, LAT, 20, 1, 148)
    // dx/dy carry the aim from the crop origin, so negating them lands back on it
    expect(-crop.dx).toBeGreaterThanOrEqual(0)
    expect(-crop.dy).toBeGreaterThanOrEqual(0)
    expect(crop.tiles.length).toBeGreaterThan(0)
    expect(crop.tiles[0].left).toBe(0)
    expect(crop.tiles[0].top).toBe(0)
  })

  it('fills the template and drops the retina/subdomain placeholders', () => {
    const [first] = loupeCrop('https://{s}.tiles.test/{z}/{x}/{y}{r}.png', LNG, LAT, 14, 1, 148).tiles
    expect(first.url).toMatch(/^https:\/\/a\.tiles\.test\/14\/\d+\/\d+\.png$/)
  })
})


// ⚠️ The night map bug. The dark base is near-black on black; the MAP lifts it with
// `raster-brightness-min`, the loupe paints the same tiles as plain <img> and did not — so the
// magnifier was a black disc at the one moment somebody is hunting for a house corner.
describe('loupePaint — the loupe wears the map\'s own raster paint', () => {
  it('turns brightness-min into a screen veil, because no CSS filter lifts a black floor', () => {
    const look = loupePaint({ brightnessMin: 0.34, contrast: -0.05 })
    // 0.34 · 255 ≈ 87 — screened over the tiles this is exactly out = 0.34 + 0.66·in
    expect(look?.veil).toBe('rgb(87, 87, 87)')
    expect(look?.filter).toBe('contrast(0.95)')
  })

  it('turns the gentle night dim of a LIGHT base into a filter, with no veil', () => {
    const look = loupePaint({ brightnessMax: 0.6, saturation: -0.1, contrast: 0.1 })
    expect(look?.veil).toBeUndefined()
    expect(look?.filter).toBe('brightness(0.6) saturate(0.9) contrast(1.1)')
  })

  it('costs the ordinary day map nothing at all', () => {
    expect(loupePaint({})).toBeNull()
    expect(loupePaint({ brightnessMin: 0, contrast: 0 })).toBeNull()
  })
})
