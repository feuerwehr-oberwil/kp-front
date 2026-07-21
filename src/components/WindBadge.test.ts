import { describe, it, expect } from 'vitest'
import { windArrowRotation } from './WindBadge'

describe('windArrowRotation', () => {
  it('rotates by the FROM bearing on a north-up map (aims the arrow downwind)', () => {
    expect(windArrowRotation(225)).toBe(225)
    expect(windArrowRotation(0)).toBe(0)
  })

  it('follows the map rotation by subtracting the bearing (like the compass needle)', () => {
    // map rotated 90° clockwise → the same wind reads 90° less on screen
    expect(windArrowRotation(225, 90)).toBe(135)
    expect(windArrowRotation(45, 45)).toBe(0)
    expect(windArrowRotation(10, 40)).toBe(-30)
  })
})
