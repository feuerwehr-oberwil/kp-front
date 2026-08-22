import { describe, expect, it } from 'vitest'
import { forkBearing } from './mapView'

/** ~1 px of longitude at zoom 17 near Oberwil, for building degenerate tails on purpose. */
const PX = 360 / (256 * 2 ** 17)

describe('forkAngle — the bearing the Teilstück fork caps the line with', () => {
  it('follows the line where the tail is long enough to carry a direction', () => {
    const east = forkBearing([[7.55, 47.51], [7.556, 47.51]], 17, 12)
    expect(Math.abs(east)).toBeLessThan(1) // screen east = 0°
    const north = forkBearing([[7.55, 47.51], [7.55, 47.514]], 17, 12)
    expect(north).toBeCloseTo(-90, 0) // screen y grows downward
  })

  it('ignores a final vertex that is a few pixels away, instead of spinning on it', () => {
    // an east-running hose whose last click landed 2 px NORTH — the raw last segment says «north»
    // and stood the fork across the line; the printed sheet never did this because kroki.py looks
    // back a fixed distance for its reference point.
    const jog: [number, number][] = [[7.55, 47.51], [7.556, 47.51], [7.556, 47.51 + 2 * PX * 0.68]]
    expect(Math.abs(forkBearing(jog, 17, 12))).toBeLessThan(15)
    // …and with a lookback shorter than the jog it does follow it — the walk is the only thing
    // deciding this, so the guard cannot be an accident of the geometry
    expect(Math.abs(forkBearing(jog, 17, 0.5))).toBeGreaterThan(60)
  })

  it('falls back to the first vertex when the whole line is shorter than the lookback', () => {
    expect(forkBearing([[7.55, 47.51], [7.5501, 47.51]], 17, 500)).toBeCloseTo(0, 0)
  })
})
