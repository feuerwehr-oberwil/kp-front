import { describe, it, expect } from 'vitest'
import { luefterVariant, LUEFTER, LUEFTER_EXTRACT, boomKnuckle } from './symbolRender'
import { symbolControls } from './symbols'

describe('luefterVariant — Lüfter airflow direction', () => {
  it('swaps the mobile Lüfter to the reversed-arrow glyph only when extract is set', () => {
    expect(luefterVariant(LUEFTER, true)).toBe(LUEFTER_EXTRACT)
    expect(luefterVariant(LUEFTER, false)).toBe(LUEFTER)
    expect(luefterVariant(LUEFTER, undefined)).toBe(LUEFTER)
  })

  it('never touches other symbols, even with extract set', () => {
    expect(luefterVariant('VKF Feuer', true)).toBe('VKF Feuer')
    expect(luefterVariant('Grosslüfter', true)).toBe('Grosslüfter')
    expect(luefterVariant(undefined, true)).toBeUndefined()
  })

  it('offers the airflow control on the mobile Lüfter (and not on a plain symbol)', () => {
    expect(symbolControls(LUEFTER).has('airflow')).toBe(true)
    expect(symbolControls('VKF Feuer').has('airflow')).toBe(false)
  })
})

describe('boomKnuckle — auto-articulated Hubretter boom knuckle', () => {
  it('sits ~55% along the base→tip line, pushed perpendicular by ~18% of the length', () => {
    // horizontal boom of length 100 to the right: knuckle at x=55, offset +18 in +y (perp of +x is +y)
    const [x, y] = boomKnuckle([0, 0], [100, 0])
    expect(x).toBeCloseTo(55, 5)
    expect(y).toBeCloseTo(18, 5)
  })

  it('keeps the perpendicular offset on the same side when the boom points up', () => {
    // boom of length 100 pointing up (−y): perp of (0,−100) rotated +90° is (+100,0)→ scaled 0.18
    const [x, y] = boomKnuckle([0, 0], [0, -100])
    expect(y).toBeCloseTo(-55, 5)
    expect(x).toBeCloseTo(18, 5)
  })

  it('is length-proportional (a longer boom bows wider) and honours a base offset', () => {
    const [x, y] = boomKnuckle([10, 10], [10, 210]) // length 200 down from (10,10)
    expect(y).toBeCloseTo(10 + 110, 5) // 55% of 200
    expect(x).toBeCloseTo(10 - 36, 5)  // perp of (0,200)/+90° = (−200,0) → 0.18·(−200) = −36
  })

  it('a zero-length boom degenerates to the base point', () => {
    expect(boomKnuckle([7, 3], [7, 3])).toEqual([7, 3])
  })
})
