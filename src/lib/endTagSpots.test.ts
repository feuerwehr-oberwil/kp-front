import { describe, expect, it } from 'vitest'
import { endTagText, placeEndTag } from './endTagSpots'

// Sweep 28.10.2026 #8b: the plan's end tag is pinned to its line and dodges what stands there –
// «i'm a bit worried if there are other symbols in the vicinity that they'll get blocked».
describe('placeEndTag — a pinned tag that dodges', () => {
  const line: [number, number][] = [[0, 100], [300, 100]] // level, left to right
  const W = 36, H = 17
  const box = ([x, y]: [number, number]) => ({ x: x - 14, y: y - 14, w: 28, h: 28 }) // a 28 px glyph

  it('free: 72 % along, 14 px above a level line', () => {
    expect(placeEndTag(line, W, H, [])).toEqual([216, 86])
  })

  it('a symbol on that spot sends it to the other side, then along the segment', () => {
    expect(placeEndTag(line, W, H, [box([216, 80])])).toEqual([216, 114])
    expect(placeEndTag(line, W, H, [box([216, 80]), box([216, 120])])).toEqual([150, 86])
  })

  it('everything taken: the first spot – a covered tag still sits on its own line', () => {
    expect(placeEndTag(line, W, H, [{ x: -50, y: 0, w: 400, h: 300 }])).toEqual([216, 86])
  })

  it('beside a vertical line, clear of the stroke by half its width', () => {
    const [x, y] = placeEndTag([[100, 0], [100, 100]], W, H, [])
    expect(y).toBe(72)
    expect(100 - x).toBe(W / 2 + 5.5)
  })

  it('says the Leitung\'s facts as one string', () => {
    expect(endTagText({ lineNo: 1, content: 'S', floorTag: 2 })).toBe('1 · S · +2')
    expect(endTagText({})).toBe('')
  })
})
