import { describe, expect, it } from 'vitest'
import { ARRIVAL_FADE_MS, ARRIVAL_SWEEP_MS, arrivalDelays, waveDelay } from './arrival'

const view = { center: [7.555, 47.515] as [number, number], zoom: 16 }

describe('arrivalDelays', () => {
  it('runs west to east across the screen and clamps what is off it', () => {
    const d = arrivalDelays([
      { id: 'far-west', lng: 7.50, lat: 47.515 },
      { id: 'west', lng: 7.553, lat: 47.515 },
      { id: 'centre', lng: 7.555, lat: 47.515 },
      { id: 'east', lng: 7.557, lat: 47.515 },
      { id: 'far-east', lng: 7.60, lat: 47.515 },
    ], view, 1180)
    expect(d.get('far-west')).toBe(0)
    expect(d.get('far-east')).toBe(ARRIVAL_SWEEP_MS)
    expect(d.get('centre')).toBe(ARRIVAL_SWEEP_MS / 2)
    expect(d.get('west')!).toBeLessThan(d.get('centre')!)
    expect(d.get('centre')!).toBeLessThan(d.get('east')!)
    // 0.002° at z16 on a 1180px screen is well inside the view, not at its edge
    expect(d.get('west')!).toBeGreaterThan(0)
    expect(d.get('east')!).toBeLessThan(ARRIVAL_SWEEP_MS)
  })
  it('skips an object without coordinates (it has no marker)', () => {
    expect(arrivalDelays([{ id: 'addr-only', lng: null, lat: null }], view, 1000).size).toBe(0)
  })
})

describe('waveDelay', () => {
  it('a marker mounting mid-wave waits only for the rest, then not at all', () => {
    expect(waveDelay(300, 0)).toBe(300)
    expect(waveDelay(300, 100)).toBe(200)
    expect(waveDelay(300, 400)).toBe(0)
  })
  it('one whose fade has already passed mounts without an entrance', () => {
    expect(waveDelay(300, 300 + ARRIVAL_FADE_MS + 1)).toBeNull()
  })
})
