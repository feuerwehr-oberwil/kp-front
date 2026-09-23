import { describe, expect, it } from 'vitest'
import { floorGeometry, rigidTileShift } from './whiteboard'
import { rotateAround } from './selectionTransform'
import type { BoardPoint } from '../types'

/* D1 of the 23.09.2026 post-mortem: a stroke dragged past its storey tile's edge was clamped PER
 * VERTEX (`localY` → clamp01), so every vertex that crossed landed on y = 1 while the rest kept
 * travelling — the Leitung's shape was destroyed, and the Karte hose baked off it with it. The
 * body drag (Whiteboard · drawMove) and the SelectionBar (Whiteboard · barApply) now both write
 * through `floorGeometry · moveRigid`, which limits the TRANSLATION. These tests drive it with
 * exactly the frame each of those two writers hands it. */

// the Gebäude of the field incident: storeys −1 … 4, drawn top = highest
const FLOORS_TTB = [4, 3, 2, 1, 0, -1]
const N = FLOORS_TTB.length
const geo = floorGeometry(true, FLOORS_TTB, N)

/** every pairwise offset of a stroke, in tile-local units — the shape, independent of where it is */
const shape = (pts: readonly BoardPoint[]) => pts.flatMap((p, i) => pts.slice(i + 1).map((q) => [q[0] - p[0], q[1] - p[1]]))
const expectSameShape = (a: readonly BoardPoint[], b: readonly BoardPoint[], digits = 9) => {
  const sa = shape(a), sb = shape(b)
  expect(sa.length).toBe(sb.length)
  sa.forEach(([dx, dy], i) => { expect(sb[i][0]).toBeCloseTo(dx, digits); expect(sb[i][1]).toBeCloseTo(dy, digits) })
}
const within01 = (pts: readonly BoardPoint[]) => pts.every((p) => p[1] >= 0 && p[1] <= 1)

/** Whiteboard · drawMove — a pure translation of the start geometry */
const drawMove = (pts: BoardPoint[], home: number, ndx: number, ndy: number, pinned?: (i: number) => BoardPoint | null) =>
  geo.moveRigid(geo.boardPts(pts, home), home, (x, by) => [x + ndx, by + ndy], pinned)
/** Whiteboard · barApply — a turn about the selection centre (in px proportions), then the move */
const barApply = (pts: BoardPoint[], home: number, t: { ndx: number; ndy: number; deg: number }, xScale = 1) => {
  const bpts = geo.boardPts(pts, home)
  const cx = bpts.reduce((s, p) => s + p[0], 0) / bpts.length, cy = bpts.reduce((s, p) => s + p[1], 0) / bpts.length
  return geo.moveRigid(bpts, home, (x, by) => {
    const [rx, ry] = t.deg ? rotateAround([x, by], [cx, cy], t.deg, { xScale }) : [x, by]
    return [rx + t.ndx, ry + t.ndy]
  })
}

// prod 23.09.2026 18:22:19, Leitung d1790186466523-1tuir: the six vertices the drag STARTED from
// (its board.add), and the drag the operator made (the final board.move's first vertex, which was
// the only one still inside the tile: +0.252 tile-local down, −0.0146 across)
const FIELD_LINE: BoardPoint[] = [
  [0.5594606614476276, 0.7317920763602359, 0], [0.5828790725744891, 0.8744478562632905, 0],
  [0.5973240710893348, 0.9124888891882836, 0], [0.6075300530102791, 0.923698358676833, 0],
  [0.6650493429890608, 0.9481323737782219, 0], [0.7844723338989077, 0.9439867690401709, 0],
]
const FIELD_DRAG = { ndx: 0.5448739556757053 - 0.5594606614476276, ndy: (0.9837921760315975 - 0.7317920763602359) / N }

describe('a stroke dragged past its storey tile keeps its shape (post-mortem D1)', () => {
  it('reproduces the field: the per-point clamp flattened 5 of 6 vertices onto y = 1', () => {
    // the OLD writer, verbatim in spirit: localY on each vertex
    const bpts = geo.boardPts(FIELD_LINE, 0)
    const old = bpts.map(([x, by, f]): BoardPoint => [x + FIELD_DRAG.ndx, geo.localY(by + FIELD_DRAG.ndy, f ?? 0), f ?? 0])
    expect(old.filter((p) => p[1] === 1)).toHaveLength(5)
  })

  it('the body drag (drawMove) stops the WHOLE stroke at the edge, every pairwise offset intact', () => {
    const moved = drawMove(FIELD_LINE, 0, FIELD_DRAG.ndx, FIELD_DRAG.ndy)
    expectSameShape(FIELD_LINE, moved)
    expect(within01(moved)).toBe(true)
    expect(Math.max(...moved.map((p) => p[1]))).toBeCloseTo(1, 12) // it came to rest ON the edge
    expect(moved.every((p) => p[2] === 0)).toBe(true)               // …and on its own storey
    // the x part of the drag is not the edge's business
    moved.forEach((p, i) => expect(p[0]).toBeCloseTo(FIELD_LINE[i][0] + FIELD_DRAG.ndx, 12))
  })

  it('the SelectionBar (barApply) does the same for a move and for a turn', () => {
    const moved = barApply(FIELD_LINE, 0, { ...FIELD_DRAG, deg: 0 })
    expectSameShape(FIELD_LINE, moved)
    expect(within01(moved)).toBe(true)
    // a turn that swings the tail over the edge: the turned shape is what is preserved
    const turned = barApply(FIELD_LINE, 0, { ndx: 0, ndy: 0.02, deg: 25 })
    expect(within01(turned)).toBe(true)
    // same rotation about the same centre as barApply's own (the centroid), compared as shapes
    const bpts = geo.boardPts(FIELD_LINE, 0)
    const c: [number, number] = [bpts.reduce((s, p) => s + p[0], 0) / 6, bpts.reduce((s, p) => s + p[1], 0) / 6]
    const reference = bpts.map(([x, by]): BoardPoint => { const [rx, ry] = rotateAround([x, by], c, 25); return [rx, ry * N - FLOORS_TTB.indexOf(0), 0] })
    expectSameShape(reference, turned)
  })

  it('upward past the tile top, and on a storey that is not the bottom one', () => {
    const onTwo: BoardPoint[] = FIELD_LINE.map(([x, y]) => [x, 1 - y, 2])
    const moved = drawMove(onTwo, 2, 0, -0.5 / N)
    expectSameShape(onTwo, moved)
    expect(Math.min(...moved.map((p) => p[1]))).toBeCloseTo(0, 12)
    expect(moved.every((p) => p[2] === 2)).toBe(true)
  })

  it('a stroke that climbs storeys keeps every vertex on its OWN tile, shifted together', () => {
    const stair: BoardPoint[] = [[0.2, 0.8, 0], [0.3, 0.9, 0], [0.35, 0.1, 1], [0.5, 0.3, 1]]
    const moved = drawMove(stair, 0, 0.01, 0.25 / N)
    expect(moved.map((p) => p[2])).toEqual([0, 0, 1, 1])
    expectSameShape(stair, moved)
    expect(within01(moved)).toBe(true)
  })

  it('an attached end stays pinned where it is; the free vertices move as one', () => {
    const pinnedEnd: BoardPoint = [0.7844723338989077, 0.9439867690401709, 0]
    const moved = drawMove(FIELD_LINE, 0, FIELD_DRAG.ndx, FIELD_DRAG.ndy, (i) => (i === 5 ? pinnedEnd : null))
    expect(moved[5]).toBe(pinnedEnd)
    expectSameShape(FIELD_LINE.slice(0, 5), moved.slice(0, 5))
    expect(within01(moved)).toBe(true)
  })

  it('writes a storey back only where one was stored — `[x, y]` stays `[x, y]`', () => {
    const bare: BoardPoint[] = [[0.2, 0.2], [0.4, 0.3], [0.5, 0.35, 0]]
    const moved = drawMove(bare, 0, 0.1, 0)
    expect(moved.map((p) => p.length)).toEqual([2, 2, 3])
    // single sheet: no storeys, no clamp — exactly the translation
    const flat = floorGeometry(false, [0], 1)
    const off = flat.moveRigid(flat.boardPts(bare, 0), 0, (x, by) => [x + 0.1, by + 0.9])
    expect(off.map((p) => p.length)).toEqual([2, 2, 3])
    expect(off[0][1]).toBeCloseTo(1.1, 12)
  })

  it('a shape taller than one tile is centred, and only its overhang is flattened', () => {
    expect(rigidTileShift([-0.4, 0.9])).toBeCloseTo(0.25, 12)
    expect(rigidTileShift([0.2, 1.3])).toBeCloseTo(-0.25, 12) // taller than a tile: centred
    expect(rigidTileShift([0.2, 1.1])).toBeCloseTo(-0.1, 12)
    expect(rigidTileShift([-0.2, 0.5])).toBeCloseTo(0.2, 12)
    expect(rigidTileShift([0.1, 0.9])).toBe(0)
    expect(rigidTileShift([])).toBe(0)
    expect(rigidTileShift([-0.5, 1.2])).toBeCloseTo(0.15, 12)
  })
})

describe('LOAD — 500 strokes × 100 drag samples each, across tile edges', () => {
  it('zero shape distortion, every vertex on its tile, bounded time', () => {
    // deterministic LCG, so a failure reproduces
    let seed = 0x2309
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
    const strokes = Array.from({ length: 500 }, () => {
      const floor = FLOORS_TTB[Math.floor(rnd() * N)]
      const n = 2 + Math.floor(rnd() * 11)
      const cx = 0.2 + rnd() * 0.6, cy = 0.2 + rnd() * 0.6, r = 0.02 + rnd() * 0.15
      const pts = Array.from({ length: n }, (): BoardPoint => [cx + (rnd() - 0.5) * 2 * r, Math.min(1, Math.max(0, cy + (rnd() - 0.5) * 2 * r)), floor])
      return { floor, pts }
    })
    let worst = 0, samples = 0
    const t0 = performance.now()
    for (const s of strokes) {
      const bpts = geo.boardPts(s.pts, s.floor)
      const ref = shape(s.pts)
      for (let k = 0; k < 100; k++) {
        // drag samples swing ±1.5 tiles vertically — most cross an edge, many cross several
        const ndy = (rnd() - 0.5) * 3 / N, ndx = (rnd() - 0.5) * 0.4
        const out = k % 2
          ? geo.moveRigid(bpts, s.floor, (x, by) => [x + ndx, by + ndy])
          : barApply(s.pts, s.floor, { ndx, ndy, deg: 0 })
        samples++
        if (!within01(out) || out.some((p) => p[2] !== s.floor)) throw new Error('left its tile')
        shape(out).forEach(([dx, dy], i) => { worst = Math.max(worst, Math.abs(dx - ref[i][0]), Math.abs(dy - ref[i][1])) })
      }
    }
    const ms = performance.now() - t0
    expect(samples).toBe(50_000)
    expect(worst).toBeLessThan(1e-9)
    // a 60 Hz drag has ~16 ms per frame for everything; one stroke's rewrite must be a sliver of it
    expect(ms / samples).toBeLessThan(0.2)
  })
})
