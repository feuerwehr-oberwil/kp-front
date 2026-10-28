import { describe, expect, it } from 'vitest'
import { snapToStep } from './sliderStep'

// The Symbolgrösse slider runs 0.6–1.4 in 0.05 steps (lib/prefs · SYMBOL_SCALE): a value that
// came out as 1.1500000000000001 would be stored and compared as such.
describe('snapToStep', () => {
  it('lands on the step grid without float dust', () => {
    expect(snapToStep(0.6 + 11 * 0.05, 0.6, 0.05)).toBe(1.15)
    expect(snapToStep(1.137, 0.6, 0.05)).toBe(1.15)
    expect(snapToStep(0.7000000000000001, 0.2, 0.05)).toBe(0.7)
  })
  it('keeps integer steps integers, counted from min', () => {
    expect(snapToStep(54.4, 0, 1)).toBe(54)
    expect(snapToStep(12, 5, 5)).toBe(10)
  })
})
