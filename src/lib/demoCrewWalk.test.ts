import { describe, expect, it } from 'vitest'
import { seedWalkers, stepWalker, stepWalkers, syncWalkers, type Walker } from './demoCrewWalk'
import type { LngLat } from '../types'

// The demo's crew dots are walked in the browser and never posted (see the module header): the
// public demo may not carry real coordinates. These lock in the two properties that make the
// simulation READ as a crew rather than as a bug — it moves at a walking pace, and it stays on
// the Lage — plus the reconciliation that lets one dot join and leave without restarting the rest.

const CENTER: LngLat = [7.53, 47.41]
const crew = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, displayName: `Person ${i}` }))
const straight = () => 0.5 // no heading drift — a deterministic walk for the assertions

/** metres between two points at this latitude (mirrors the module's local approximation) */
const dist = (a: LngLat, b: LngLat) =>
  Math.hypot((b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110_540)

describe('seedWalkers', () => {
  it('spreads the crew around the incident instead of stacking them on it', () => {
    const ws = seedWalkers(CENTER, crew(3), 70)
    expect(ws).toHaveLength(3)
    for (const w of ws) expect(dist(CENTER, w.coord)).toBeCloseTo(70, 0)
    // …and the default keeps a walker close to its anchor (the leash is short on purpose)
    for (const w of seedWalkers(CENTER, crew(2))) expect(dist(CENTER, w.coord)).toBeLessThan(60)
    // three distinct places, not one dot with two hidden underneath
    expect(new Set(ws.map((w) => w.coord.join(','))).size).toBe(3)
  })

  it('keeps each person’s identity, so the dot can be matched to the roster', () => {
    expect(seedWalkers(CENTER, crew(2)).map((w) => w.personId)).toEqual(['p0', 'p1'])
  })
})

describe('stepWalker', () => {
  it('moves at a walking pace — metres per tick, not kilometres', () => {
    const [w] = seedWalkers(CENTER, crew(1), 0)
    const next = stepWalker(w, CENTER, 15_000, straight)
    const moved = dist(w.coord, next.coord)
    expect(moved).toBeGreaterThan(5)
    expect(moved).toBeLessThan(40) // 15 s of walking, never a car
  })

  it('turns back once it reaches the leash, so nobody walks off the Lage', () => {
    // start well outside the leash, heading further out
    const far: Walker = { personId: 'p', displayName: 'P', coord: [CENTER[0] + 0.006, CENTER[1]], heading: 90 }
    expect(dist(CENTER, far.coord)).toBeGreaterThan(90)
    let w = far
    for (let i = 0; i < 40; i++) w = stepWalker(w, CENTER, 15_000, straight)
    expect(dist(CENTER, w.coord)).toBeLessThan(dist(CENTER, far.coord))
  })

  it('stands still for a zero-length tick (a re-render must not teleport anyone)', () => {
    const [w] = seedWalkers(CENTER, crew(1))
    expect(stepWalker(w, CENTER, 0, straight).coord).toEqual(w.coord)
  })
})

describe('syncWalkers', () => {
  it('keeps the walk of everyone still listed', () => {
    const start = seedWalkers(CENTER, crew(2))
    const moved = stepWalkers(start, CENTER, 15_000, straight)
    const same = syncWalkers(moved, crew(2), CENTER)
    expect(same.map((w) => w.coord)).toEqual(moved.map((w) => w.coord))
  })

  it('seeds a newcomer (the visitor tapping «Standort teilen») without restarting the others', () => {
    const moved = stepWalkers(seedWalkers(CENTER, crew(2)), CENTER, 15_000, straight)
    const next = syncWalkers(moved, [...crew(2), { id: 'me', displayName: 'Ich' }], CENTER)
    expect(next).toHaveLength(3)
    expect(next[0].coord).toEqual(moved[0].coord)
    expect(next[2].personId).toBe('me')
  })

  it('drops whoever stopped sharing', () => {
    const moved = stepWalkers(seedWalkers(CENTER, crew(3)), CENTER, 15_000, straight)
    expect(syncWalkers(moved, crew(2), CENTER).map((w) => w.personId)).toEqual(['p0', 'p1'])
  })

  it('follows a rename without moving the dot', () => {
    const moved = stepWalkers(seedWalkers(CENTER, crew(1)), CENTER, 15_000, straight)
    const next = syncWalkers(moved, [{ id: 'p0', displayName: 'Neuer Name' }], CENTER)
    expect(next[0].displayName).toBe('Neuer Name')
    expect(next[0].coord).toEqual(moved[0].coord)
  })
})
