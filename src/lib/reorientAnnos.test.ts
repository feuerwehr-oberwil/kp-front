import { describe, expect, it } from 'vitest'
import { bandAspect, buildView, fpBoxFrac, remapPoint, type Pt, type Ring } from './footprint'
import { reorientAnnos } from './reorientAnnos'
import type { BoardAnno } from '../types'

// an L-shaped outline, turned off the axes so every angle moves every point
const L: Ring[] = [[[0.1, 0.1], [0.9, 0.2], [0.85, 0.5], [0.45, 0.45], [0.4, 0.9], [0.05, 0.8]]]
const N = 3, AR = 0.72
const UNIT = { boardW: 1, boardH: N * AR, floors: N }

const SHEET: BoardAnno[] = [
  { id: 's', kind: 'shape', shape: 'arrow', sizeN: 0.1, x: 0.4, y: 0.55, floor: 1, rotation: 30 },
  { id: 'w', kind: 'draw', role: 'wand', pts: [[0.2, 0.3], [0.6, 0.3, 2], [0.6, 0.7]], floor: 1 },
  { id: 'r', kind: 'resource', text: 'AS 1', x: 0.5, y: 0.5, trail: [{ x: 0.3, y: 0.4, t: '03:10', floor: 0 }, { x: 0.5, y: 0.5, t: '03:14' }] },
  { id: 'a', kind: 'area', pts: [[0.3, 0.3], [0.7, 0.3], [0.5, 0.7]] },
  { id: 'c', kind: 'circle', x: 0.45, y: 0.5, radiusN: 0.1 },
]

const close = (a: number | undefined, b: number | undefined) => expect(a).toBeCloseTo(b!, 10)
const samePlace = (got: BoardAnno[], want: BoardAnno[]) => got.forEach((g, i) => {
  const w = want[i]
  if (w.x != null) { close(g.x, w.x); close(g.y, w.y) }
  g.pts?.forEach((p, j) => { close(p[0], w.pts![j][0]); close(p[1], w.pts![j][1]); expect(p[2]).toBe(w.pts![j][2]) })
  g.trail?.forEach((p, j) => { close(p.x, w.trail![j].x); close(p.y, w.trail![j].y); expect(p.floor).toBe(w.trail![j].floor) })
})

describe('reorientAnnos', () => {
  it('re-glues anchors, vertices (each keeping its storey), trails and bearings through remapPoint', () => {
    const out = reorientAnnos(SHEET, { src: L, fromDeg: 12, toDeg: 70, layout: UNIT })
    const mv = (p: Pt) => remapPoint(L, 12, 70, UNIT, p)
    expect(mv([0.4, 0.55])).toEqual([out[0].x, out[0].y])
    expect(out[0].rotation).toBe(88)
    expect(out[1].pts).toEqual([[...mv([0.2, 0.3])], [...mv([0.6, 0.3]), 2], [...mv([0.6, 0.7])]])
    expect(out[2].trail?.map((p) => [p.x, p.y, p.t, p.floor])).toEqual([[...mv([0.3, 0.4]), '03:10', 0], [...mv([0.5, 0.5]), '03:14', undefined]])
    expect(out[4].radiusN).toBe(0.1)
  })

  // The preview renders onto a unit board, the commit onto the board in px: only the ratio may count.
  it('preview at X == commit at X on an outline, whose band does not follow the turn', () => {
    const preview = reorientAnnos(SHEET, { src: L, fromDeg: 12, toDeg: 70, layout: UNIT })
    const px = { boardW: 820, boardH: 820 * N * AR, floors: N }
    const commit = reorientAnnos(SHEET, { src: L, fromDeg: 12, toDeg: 70, layout: px, toLayout: px })
    samePlace(preview, commit)
  })

  // A pack's band follows its frame, but only at the commit; the preview draws the turned frame
  // into the band on screen. Both must put the ink on the same spot of the DRAWING.
  it('preview at X lands on the same spot of a pack drawing as the commit at X', () => {
    const FRAME: Ring[] = [[[0, 0], [2, 0], [2, 0.6], [0, 0.6]]]
    const on = { boardW: 1, boardH: N * bandAspect(buildView(FRAME, 0).aspect), floors: N }
    const after = { boardW: 1, boardH: N * bandAspect(buildView(FRAME, 80).aspect), floors: N }
    const preview = reorientAnnos(SHEET, { src: FRAME, fromDeg: 0, toDeg: 80, layout: on })
    const commit = reorientAnnos(SHEET, { src: FRAME, fromDeg: 0, toDeg: 80, layout: on, toLayout: after })
    const aspect = buildView(FRAME, 80).aspect
    const local = (p: Pt, b: typeof on): Pt => {
      const { rw, rh } = fpBoxFrac(aspect, b.boardW, b.boardH, b.floors)
      return [(p[0] - (0.5 - rw / 2)) / rw, (p[1] - (0.5 - rh / 2)) / rh]
    }
    const [pv, cm] = [local([preview[0].x!, preview[0].y!], on), local([commit[0].x!, commit[0].y!], after)]
    close(pv[0], cm[0]); close(pv[1], cm[1])
    const [pw, cw] = [local([preview[1].pts![1][0], preview[1].pts![1][1]], on), local([commit[1].pts![1][0], commit[1].pts![1][1]], after)]
    close(pw[0], cw[0]); close(pw[1], cw[1])
  })

  it('a turn of nothing is the sheet itself', () => {
    expect(reorientAnnos(SHEET, { src: L, fromDeg: 33, toDeg: 33, layout: UNIT })).toBe(SHEET)
  })
})
