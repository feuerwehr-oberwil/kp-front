import { describe, expect, it } from 'vitest'
import { isMarqueeTap, marqueeContains, MARQUEE_TAP_PX } from './marquee'

describe('isMarqueeTap', () => {
  it('treats a sub-threshold drag on both axes as a tap', () => {
    expect(isMarqueeTap({ x0: 100, y0: 100, x1: 103, y1: 104 })).toBe(true)
    expect(isMarqueeTap({ x0: 100, y0: 100, x1: 100, y1: 100 })).toBe(true)
  })
  it('is a box once either axis reaches the threshold', () => {
    expect(isMarqueeTap({ x0: 100, y0: 100, x1: 100 + MARQUEE_TAP_PX, y1: 100 })).toBe(false)
    expect(isMarqueeTap({ x0: 100, y0: 100, x1: 100, y1: 100 + MARQUEE_TAP_PX })).toBe(false)
  })
  it('normalizes direction (drag up-left is the same as down-right)', () => {
    expect(isMarqueeTap({ x0: 200, y0: 200, x1: 150, y1: 150 })).toBe(false)
  })
})

describe('marqueeContains', () => {
  // project treats the point's own [x, y] as already-client coords, so we test the bounds math directly
  const projectIdentity = ([x, y]: [number, number]) => ({ cx: x, cy: y })

  it('includes points inside the box and excludes points outside', () => {
    const inBox = marqueeContains({ x0: 10, y0: 10, x1: 50, y1: 50 }, projectIdentity)
    expect(inBox([30, 30])).toBe(true) // interior
    expect(inBox([10, 50])).toBe(true) // corner (inclusive)
    expect(inBox([5, 30])).toBe(false) // left of box
    expect(inBox([30, 60])).toBe(false) // below box
  })

  it('handles a box dragged in the negative direction (x1<x0, y1<y0)', () => {
    const inBox = marqueeContains({ x0: 50, y0: 50, x1: 10, y1: 10 }, projectIdentity)
    expect(inBox([30, 30])).toBe(true)
    expect(inBox([60, 30])).toBe(false)
  })

  it('applies the projection before the bounds test', () => {
    // a point at board-normalized (0.5, 0.5) scaled by a 200px rect at offset 100 → client (200, 200)
    const inBox = marqueeContains({ x0: 150, y0: 150, x1: 250, y1: 250 }, (p: { x: number; y: number }) => ({
      cx: 100 + p.x * 200,
      cy: 100 + p.y * 200,
    }))
    expect(inBox({ x: 0.5, y: 0.5 })).toBe(true) // → (200,200), inside
    expect(inBox({ x: 0.1, y: 0.1 })).toBe(false) // → (120,120), outside
  })
})
