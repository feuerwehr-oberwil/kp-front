import { describe, expect, it } from 'vitest'
import { planLoupeDraws, type LoupeSource } from './planLoupe'

// a 124px loupe at 4× shows a 31px crop of the screen
const SIZE = { w: 124, h: 124 }

describe('planLoupeDraws · the loupe copies the sheet from whatever pictures it is made of', () => {
  it('crops a tile around the aim, through the tile’s own pixel density', () => {
    // one 512px tile drawn 256 CSS px wide at (100, 100): 2 tile px per CSS px
    const tile: LoupeSource = { left: 100, top: 100, width: 256, height: 256, pxW: 512, pxH: 512 }
    const [d] = planLoupeDraws({ x: 200, y: 200 }, SIZE, 4, 3, [tile])
    // crop 31×31 around (200,200) → client 184.5…215.5 → tile px (84.5…115.5)·2
    expect(d).toMatchObject({ index: 0, sx: 169, sy: 169, sw: 62, sh: 62, dx: 0, dy: 0 })
    // …filling the whole backing store (124 × dpr 3)
    expect(d.dw).toBeCloseTo(372); expect(d.dh).toBeCloseTo(372)
  })

  it('splits the crop across neighbouring tiles and keeps their paint order', () => {
    const left: LoupeSource = { left: 0, top: 0, width: 200, height: 400, pxW: 200, pxH: 400 }
    const right: LoupeSource = { left: 200, top: 0, width: 200, height: 400, pxW: 200, pxH: 400 }
    const far: LoupeSource = { left: 1000, top: 0, width: 200, height: 400, pxW: 200, pxH: 400 }
    const draws = planLoupeDraws({ x: 200, y: 200 }, SIZE, 4, 1, [left, far, right])
    expect(draws.map((d) => d.index)).toEqual([0, 2])
    // the seam sits in the middle of the loupe: each tile fills its half
    expect(draws[0]).toMatchObject({ dx: 0, dw: 62 })
    expect(draws[1]).toMatchObject({ dx: 62, dw: 62 })
  })

  it('draws nothing from a picture that has no pixels yet or is hidden', () => {
    const cold: LoupeSource = { left: 0, top: 0, width: 400, height: 400, pxW: 0, pxH: 0 }
    const hidden: LoupeSource = { left: 0, top: 0, width: 0, height: 0, pxW: 800, pxH: 800 }
    expect(planLoupeDraws({ x: 200, y: 200 }, SIZE, 4, 3, [cold, hidden])).toEqual([])
  })
})
