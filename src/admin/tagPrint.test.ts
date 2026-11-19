import { describe, expect, it } from 'vitest'
import { tagBoxes } from './tagPrint'

describe('tagBoxes', () => {
  it('puts one tag on each page for the single and tape formats', () => {
    for (const f of ['single', 'tape36', 'tape24'] as const) {
      expect(tagBoxes(f, 3).map((b) => b.page)).toEqual([0, 1, 2])
    }
  })

  it('stacks seven 35 mm tags on an A4 page, inside the margins', () => {
    const boxes = tagBoxes('a4', 15)
    expect(boxes.map((b) => b.page)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2])
    const last = boxes[6]
    expect(last.y + 35).toBeLessThanOrEqual(297 - 12)
    expect(boxes[7].y).toBe(boxes[0].y)
    expect(boxes[0].x).toBe(30) // 150 mm centred on 210 mm
  })
})
