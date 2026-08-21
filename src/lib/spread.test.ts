import { describe, it, expect } from 'vitest'
import { normalizeSpread, tidySpread, hasSpread } from './spread'

// The legacy half of these is the part that matters: incidents written before 2026-08 carry
// `h`/`hBounded`/`vBounded`, and the blob is never migrated in place. If this drifts, spread
// arrows quietly vanish from old Lagen and from their printed Rapporte.

describe('normalizeSpread — legacy shape', () => {
  it('maps the exclusive horizontal direction onto its own flag', () => {
    expect(normalizeSpread({ h: 'W' })).toMatchObject({ left: true })
    expect(normalizeSpread({ h: 'E' })).toMatchObject({ right: true })
    expect(normalizeSpread({ h: 'W' }).right).toBeUndefined()
  })

  it('lands the single hBounded on whichever arrow it belonged to', () => {
    expect(normalizeSpread({ h: 'E', hBounded: true })).toMatchObject({ right: true, rightBounded: true })
    expect(normalizeSpread({ h: 'E', hBounded: true }).leftBounded).toBeUndefined()
  })

  it('applies the shared vBounded to every vertical arrow that was set', () => {
    expect(normalizeSpread({ up: true, down: true, vBounded: true })).toMatchObject({
      up: true, down: true, upBounded: true, downBounded: true,
    })
    // …but not to an arrow that was never there
    expect(normalizeSpread({ up: true, vBounded: true }).downBounded).toBeUndefined()
  })

  it('reads a full legacy symbol end to end', () => {
    expect(normalizeSpread({ h: 'W', hBounded: true, up: true, vBounded: true })).toEqual({
      left: true, right: undefined, up: true, down: undefined,
      leftBounded: true, rightBounded: undefined, upBounded: true, downBounded: undefined,
    })
  })
})

describe('normalizeSpread — current shape', () => {
  it('keeps all four directions independent', () => {
    const s = normalizeSpread({ left: true, right: true, up: true, down: true })
    expect([s.left, s.right, s.up, s.down]).toEqual([true, true, true, true])
  })

  it('keeps each bar on its own arrow', () => {
    const s = normalizeSpread({ left: true, right: true, leftBounded: true })
    expect(s.leftBounded).toBe(true)
    expect(s.rightBounded).toBeUndefined()
  })

  it('never keeps a bar whose arrow is absent', () => {
    expect(normalizeSpread({ leftBounded: true }).leftBounded).toBeUndefined()
  })

  it('is empty for nothing at all', () => {
    expect(hasSpread(normalizeSpread(null))).toBe(false)
    expect(hasSpread(normalizeSpread({}))).toBe(false)
  })
})

describe('tidySpread', () => {
  it('drops falsy keys so the stored prop stays small', () => {
    expect(tidySpread({ left: true, right: false, upBounded: true })).toEqual({ left: true })
  })

  it('returns null once the last arrow is gone, so the prop can be unset', () => {
    expect(tidySpread({})).toBeNull()
    expect(tidySpread({ left: false, downBounded: true })).toBeNull()
  })
})
