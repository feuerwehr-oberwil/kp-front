import { describe, expect, it } from 'vitest'
import { amendBuilding, georefFromPick, matchStoredRings, remapAcrossBuildings, srcAcrossGround, srcToPicker, type BuildingFrame } from './buildingTransfer'
import { buildView, fpBoxFrac, remapPoint, type Pt, type Ring } from './footprint'
import type { BoardAnno, BuildingDoc } from '../types'

const CENTER: [number, number] = [7.6, 47.5]
const R = 250
const LAYOUT = { boardW: 900, boardH: 1200 }

/** a rectangle in PICKER space (0..1 of the ±R metre-square around CENTER) */
const rect = (x: number, y: number, w: number, h: number): Ring =>
  [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]

/** normalise picker rings into `src` exactly the way OsmOutline · transfer does */
function toSrc(picked: Ring[]): Ring[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of picked) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  return picked.map((ring) => ring.map(([x, y]): Pt => [(x - minX) / span, (y - minY) / span]))
}

const frame = (picked: Ring[], angleDeg = 0, floors = 1): BuildingFrame => ({
  src: toSrc(picked), angleDeg, floors, geo: georefFromPick(CENTER, R, picked),
})

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

describe('remapAcrossBuildings — a drawing keeps its place on the GROUND', () => {
  // The Nebengebäude case: the same house, plus a second one to its east. The combined bbox grows
  // and shifts, so every stored coordinate would mean somewhere else without this transform.
  it('survives a bbox that grows and shifts', () => {
    const house = rect(0.40, 0.40, 0.10, 0.10)
    const from = frame([house])
    const to = frame([house, rect(0.55, 0.40, 0.10, 0.10)])
    // the centre of the tile is the centre of the old footprint box
    const moved = remapAcrossBuildings(from, to, LAYOUT, [0.5, 0.5])
    expect(moved).not.toBeNull()
    // …and in the new frame that ground point sits LEFT of centre (the box grew eastwards)
    expect(moved![0]).toBeLessThan(0.5)
    expect(close(moved![1], 0.5, 1e-3)).toBe(true) // nothing moved north or south
  })

  it('survives a change of principalAngleDeg', () => {
    const house = rect(0.40, 0.40, 0.20, 0.10)
    const from = frame([house], 0)
    const to = frame([house], 90) // same building, annotations re-read in a turned view
    const moved = remapAcrossBuildings(from, to, LAYOUT, [0.5, 0.5])
    expect(moved).not.toBeNull()
    expect(close(moved![0], 0.5, 1e-6)).toBe(true) // the centre is the centre in any rotation
    expect(close(moved![1], 0.5, 1e-6)).toBe(true)
  })

  it('survives both at once — and lands where the ground says, not where the rectangle does', () => {
    const house = rect(0.40, 0.40, 0.20, 0.10)
    const from = frame([house], 0)
    const to = frame([house, rect(0.40, 0.60, 0.20, 0.10)], 30)
    const p: Pt = [0.42, 0.47]
    const moved = remapAcrossBuildings(from, to, LAYOUT, p)
    expect(moved).not.toBeNull()
    // round-tripping through the inverse pair puts it back where it started
    const back = remapAcrossBuildings(to, from, LAYOUT, moved!)
    expect(back).not.toBeNull()
    expect(close(back![0], p[0], 1e-6)).toBe(true)
    expect(close(back![1], p[1], 1e-6)).toBe(true)
  })

  // ⚠️ Dropped, never clamped: a point pushed off the new sheet must not be asserted at its edge.
  it('drops a point that no longer lands on the new sheet instead of pinning it to 0,0', () => {
    const from = frame([rect(0.40, 0.40, 0.10, 0.10)])
    // a building 300 m away: nothing of the old sheet is on the new one
    const to = frame([rect(0.90, 0.90, 0.05, 0.05)])
    expect(remapAcrossBuildings(from, to, LAYOUT, [0.5, 0.5])).toBeNull()
  })

  it('does not move a point at all when the building did not change', () => {
    const house = rect(0.40, 0.40, 0.20, 0.10)
    const f = frame([house], 21)
    const p: Pt = [0.37, 0.61]
    const moved = remapAcrossBuildings(f, f, LAYOUT, p)
    expect(moved).not.toBeNull()
    expect(close(moved![0], p[0], 1e-9)).toBe(true)
    expect(close(moved![1], p[1], 1e-9)).toBe(true)
  })

  // The one case both transforms must agree on: SAME building, different view angle. If
  // footprint.ts ever moves its centred-box math, this fails rather than drifting silently.
  it('agrees with footprint · remapPoint on a pure re-orientation', () => {
    const house = rect(0.40, 0.40, 0.20, 0.10)
    const src = toSrc([house])
    const p: Pt = [0.44, 0.52]
    const mine = remapAcrossBuildings(frame([house], 0), frame([house], 37), LAYOUT, p)
    const theirs = remapPoint(src, 0, 37, { ...LAYOUT, floors: 1 }, p)
    expect(mine).not.toBeNull()
    expect(close(mine![0], theirs[0], 1e-9)).toBe(true)
    expect(close(mine![1], theirs[1], 1e-9)).toBe(true)
  })
})

describe('georefFromPick', () => {
  it('puts one src unit on the ground in metres', () => {
    // a 0.10-wide pick out of a 500 m square is 50 m across
    const geo = georefFromPick(CENTER, R, [rect(0.40, 0.40, 0.10, 0.10)])
    expect(close(geo.spanM, 50, 1e-6)).toBe(true)
  })

  it('is the identity through the ground when both frames are the same pick', () => {
    const geo = georefFromPick(CENTER, R, [rect(0.40, 0.40, 0.10, 0.10)])
    const out = srcAcrossGround(geo, geo, [0.3, 0.7])
    expect(close(out[0], 0.3, 1e-9)).toBe(true)
    expect(close(out[1], 0.7, 1e-9)).toBe(true)
  })
})

// ── the whole stack across a building change ────────────────────────────────────────────────

/** where a tile point actually IS — back out to picker space, which is a fixed metre-square
 *  around the incident and therefore the same ground for both frames */
const tileToPicker = (f: BuildingFrame, p: Pt): Pt => {
  const v = buildView(f.src, f.angleDeg)
  const b = fpBoxFrac(v.aspect, LAYOUT.boardW, LAYOUT.boardH, f.floors)
  const local: Pt = [(p[0] - (0.5 - b.rw / 2)) / b.rw, (p[1] - (0.5 - b.rh / 2)) / b.rh]
  return srcToPicker(f.geo, CENTER, R, v.fromNorm(local))
}

/** a BuildingDoc as the workspace stores one */
const doc = (picked: Ring[], floors: number[], angleDeg = 0): BuildingDoc => {
  const src = toSrc(picked)
  const view = buildView(src, angleDeg)
  return {
    src, orientDeg: angleDeg, northUp: false, floors,
    rings: view.rings, ring: view.rings[0], ringAspect: view.aspect,
    geo: georefFromPick(CENTER, R, picked),
  }
}

const sym = (id: string, x: number, y: number, floor = 0): BoardAnno => ({ id, kind: 'symbol', x, y, floor })

describe('a mark keeps its place on the GROUND, not in the rectangle', () => {
  it('lands on the same ground position after a bbox AND angle change', () => {
    const house = rect(0.40, 0.40, 0.20, 0.10)
    const from = frame([house], 0)
    const to = frame([house, rect(0.40, 0.62, 0.24, 0.12)], 30)
    const p: Pt = [0.46, 0.44]
    const moved = remapAcrossBuildings(from, to, LAYOUT, p)
    expect(moved).not.toBeNull()
    const before = tileToPicker(from, p)
    const after = tileToPicker(to, moved!)
    expect(close(after[0], before[0], 1e-9)).toBe(true)
    expect(close(after[1], before[1], 1e-9)).toBe(true)
  })
})

describe('amendBuilding', () => {
  const house = rect(0.40, 0.40, 0.20, 0.10)
  const neighbour = rect(0.62, 0.40, 0.10, 0.10)

  it('inherits the storeys, or an annotation above the ground floor is homeless', () => {
    const prev = doc([house], [1, 0, -1])
    const next = doc([house, neighbour], [0])
    const out = amendBuilding(prev, { src: next.src as Ring[], orientDeg: next.orientDeg!, geo: next.geo! }, [
      sym('a', 0.5, 0.5, 1), sym('b', 0.5, 0.5, -1),
    ])
    expect(out.floors).toEqual([1, 0, -1])
    expect(out.carried).toBe(2)
    expect(out.dropped).toBe(0)
    expect(out.annos.map((a) => a.floor)).toEqual([1, -1]) // the storey itself is untouched
  })

  it('drops what no longer lands on the new sheet — and counts it', () => {
    const prev = doc([house], [0])
    const far = doc([rect(0.90, 0.90, 0.05, 0.05)], [0])
    const out = amendBuilding(prev, { src: far.src as Ring[], orientDeg: far.orientDeg!, geo: far.geo! }, [
      sym('a', 0.5, 0.5), sym('b', 0.5, 0.52),
    ])
    expect(out.legacy).toBe(false)
    expect(out.carried).toBe(0)
    expect(out.dropped).toBe(2)
    expect(out.annos).toEqual([])
  })

  // ⚠️ A polygon is an assertion about a SHAPE — half of it re-anchored would draw a line
  // nobody drew. Dropping the Nebengebäude shrinks the sheet, so what sat over it is now off it.
  it('takes a polygon all or nothing', () => {
    const prev = doc([house, neighbour], [0])
    const next = doc([house], [0])
    const pick = { src: next.src as Ring[], orientDeg: next.orientDeg!, geo: next.geo! }
    const inside: BoardAnno = { id: 'in', kind: 'area', floor: 0, pts: [[0.50, 0.50], [0.55, 0.50], [0.55, 0.55]] }
    const overNeighbour: BoardAnno = { id: 'half', kind: 'area', floor: 0, pts: [[0.50, 0.50], [0.55, 0.50], [0.75, 0.50]] }
    const out = amendBuilding(prev, pick, [inside, overNeighbour])
    expect(out.annos.map((a) => a.id)).toEqual(['in'])
    expect(out.dropped).toBe(1)
  })

  // …and a magnetic line must let go of an anchor that did not come along, or it points at an id
  // that is no longer on the board.
  it('releases an attachment to a dropped annotation', () => {
    const prev = doc([house, neighbour], [0])
    const next = doc([house], [0])
    const pick = { src: next.src as Ring[], orientDeg: next.orientDeg!, geo: next.geo! }
    const anchor = sym('anchor', 0.75, 0.50) // over the Nebengebäude — gone with it
    const line: BoardAnno = {
      id: 'line', kind: 'draw', floor: 0, pts: [[0.50, 0.50], [0.55, 0.50]],
      startAttachment: { target: { kind: 'object', id: 'anchor' }, routing: 'direct' },
    }
    const out = amendBuilding(prev, pick, [anchor, line])
    expect(out.dropped).toBe(1)
    expect(out.annos.map((a) => a.id)).toEqual(['line'])
    expect(out.annos[0].startAttachment).toBeUndefined()
  })

  // A building saved before `geo` existed cannot be placed on the ground — the old rule stands,
  // and it must not throw on the way there.
  it('falls back to the legacy path for a building without a georeference', () => {
    const legacy = doc([house], [1, 0])
    delete legacy.geo
    const next = doc([house, neighbour], [0])
    const out = amendBuilding(legacy, { src: next.src as Ring[], orientDeg: next.orientDeg!, geo: next.geo! }, [
      sym('a', 0.5, 0.5), sym('b', 0.4, 0.4),
    ])
    expect(out.legacy).toBe(true)
    expect(out.annos).toEqual([])
    expect(out.dropped).toBe(2)
    expect(out.floors).toEqual([0]) // a stack that cannot carry its marks starts over
  })

  it('is a plain first pick when there is no building yet', () => {
    const next = doc([house], [0])
    const out = amendBuilding(null, { src: next.src as Ring[], orientDeg: next.orientDeg!, geo: next.geo! }, [])
    expect(out).toEqual({ floors: [0], annos: [], carried: 0, dropped: 0, legacy: false })
  })
})

describe('matchStoredRings — finding the saved building among the live footprints', () => {
  // three houses in the picker's bbox; the saved building is the 1st and the 3rd
  const live: Ring[] = [
    rect(0.20, 0.30, 0.08, 0.06),
    rect(0.45, 0.55, 0.12, 0.09),
    rect(0.70, 0.25, 0.10, 0.10),
  ]

  it('picks exactly the footprints the building was built from', () => {
    const picked = [live[0], live[2]]
    const geo = georefFromPick(CENTER, R, picked)
    const m = matchStoredRings(toSrc(picked), geo, CENTER, R, live)
    expect(m.indices).toEqual([0, 2])
    expect(m.missing).toBe(0)
  })

  it('does not fall for a same-shaped footprint somewhere else', () => {
    const picked = [live[0]]
    const geo = georefFromPick(CENTER, R, picked)
    // a ring of identical shape 300 m away — normalised, it is the SAME ring
    const decoy = rect(0.75, 0.75, 0.08, 0.06)
    const m = matchStoredRings(toSrc(picked), geo, CENTER, R, [decoy, live[0]])
    expect(m.indices).toEqual([1])
    expect(m.missing).toBe(0)
  })

  // offline fallback, a moved bbox, an OSM edit — the picker says so instead of quietly
  // shrinking the selection
  it('counts a saved footprint the current fetch does not contain', () => {
    const picked = [live[0], live[2]]
    const geo = georefFromPick(CENTER, R, picked)
    const m = matchStoredRings(toSrc(picked), geo, CENTER, R, [live[0], live[1]])
    expect(m.indices).toEqual([0])
    expect(m.missing).toBe(1)
  })
})
