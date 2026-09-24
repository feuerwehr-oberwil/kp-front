import { describe, expect, it } from 'vitest'
import { canDropVertex, extendEnd, insertAt, minPoints, removeVertex, replaceVertex, segmentMid } from './vertexOps'

// The one vertex rulebook both surfaces read (23.09.2026). The Karte hands lng/lat pairs, the Plan
// sheet fractions with a storey as the third element — which must pass through every operation
// untouched, or a node edited on the Gebäude would drop to the ground floor.
describe('vertexOps', () => {
  it('a Fläche keeps 3 points, every other vertex shape 2', () => {
    expect(minPoints('area')).toBe(3)
    expect(minPoints('line')).toBe(2)
    expect(minPoints('draw')).toBe(2)
    expect(canDropVertex('area', 3)).toBe(false)
    expect(canDropVertex('area', 4)).toBe(true)
    expect(canDropVertex('draw', 2)).toBe(false)
    expect(canDropVertex('line', 3)).toBe(true)
  })

  const plan: [number, number, number][] = [[0, 0, 1], [1, 0, 1], [1, 1, 2]]

  it('replaces, removes and inserts whole points — the storey rides along', () => {
    expect(replaceVertex(plan, 1, [5, 5, 3])).toEqual([[0, 0, 1], [5, 5, 3], [1, 1, 2]])
    expect(removeVertex(plan, 0)).toEqual([[1, 0, 1], [1, 1, 2]])
    // insertAt places the point AT the index: the Karte passes the index, the Plan idx + 1
    expect(insertAt(plan, 0, [9, 9, 0])[0]).toEqual([9, 9, 0])
    expect(insertAt(plan, 2, [9, 9, 0])).toEqual([[0, 0, 1], [1, 0, 1], [9, 9, 0], [1, 1, 2]])
    expect(insertAt(plan, 3, [9, 9, 0])[3]).toEqual([9, 9, 0])
  })

  it('never mutates its input', () => {
    const pts: [number, number][] = [[0, 0], [1, 1]]
    replaceVertex(pts, 0, [3, 3]); removeVertex(pts, 0); insertAt(pts, 1, [2, 2]); extendEnd(pts, 'end', [4, 4])
    expect(pts).toEqual([[0, 0], [1, 1]])
  })

  it('grows an open line at either end', () => {
    expect(extendEnd(plan, 'start', [-1, 0, 1])[0]).toEqual([-1, 0, 1])
    expect(extendEnd(plan, 'end', [2, 2, 2])).toHaveLength(4)
  })

  it('a segment midpoint wraps to vertex 0 for the closing edge of a ring', () => {
    expect(segmentMid(plan, 0)).toEqual([0.5, 0])
    expect(segmentMid(plan, 2)).toEqual([0.5, 0.5]) // [1,1] → [0,0]
  })
})
