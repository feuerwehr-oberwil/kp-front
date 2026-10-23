import { describe, expect, it } from 'vitest'
import { centroid, rotateAround, turnedBy } from './selectionTransform'

describe('centroid — the one centre resolver both surfaces ask', () => {
  it('is the plain mean of the points that define the selection', () => {
    expect(centroid([[0, 0], [10, 0], [10, 10], [0, 10]])).toEqual([5, 5])
  })

  it('has no answer for an empty selection', () => {
    expect(centroid([])).toBeNull()
  })
})

describe('rotateAround — one turn, in either surface’s frame', () => {
  it('turns clockwise on a screen/board frame (y grows down)', () => {
    const [x, y] = rotateAround([10, 0], [0, 0], 90)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(10) // 90° clockwise on screen sends «right» to «down»
  })

  it('turns the same way in a north-up frame, where y grows upward', () => {
    const [lng, lat] = rotateAround([10, 0], [0, 0], 90, { yUp: true })
    expect(lng).toBeCloseTo(0)
    expect(lat).toBeCloseTo(-10) // clockwise on screen still sends «east» to «south»
  })

  it('stays rigid when the two axes are not the same size', () => {
    // x compressed 2:1 against y (a lng/lat frame, or a board twice as wide as it is tall):
    // a quarter turn must swap the axes' EXTENTS, not their raw numbers
    const [x, y] = rotateAround([10, 0], [0, 0], 90, { xScale: 0.5 })
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(5)
  })

  it('leaves the centre and a zero turn exactly where they are', () => {
    expect(rotateAround([3, 4], [3, 4], 137)).toEqual([3, 4])
    const [x, y] = rotateAround([3, 4], [0, 0], 0)
    expect([x, y]).toEqual([3, 4])
  })

  it('comes back to itself after four quarter turns', () => {
    let p: [number, number] = [7, -2]
    for (let i = 0; i < 4; i++) p = rotateAround(p, [1, 1], 90, { xScale: 0.7 })
    expect(p[0]).toBeCloseTo(7)
    expect(p[1]).toBeCloseTo(-2)
  })
})

describe('turnedBy — a stored bearing plus a turn', () => {
  it('stays a whole degree in 0–359 whichever way it is turned', () => {
    expect(turnedBy(350, 20)).toBe(10)
    expect(turnedBy(10, -20)).toBe(350)
    expect(turnedBy(0, -720.4)).toBe(0)
  })
})
