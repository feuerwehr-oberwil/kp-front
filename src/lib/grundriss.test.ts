import { describe, expect, it } from 'vitest'
import type { BoardAnno } from '../types'
import { carryDoors, copyGrundriss, nearestWall, seatDoor, shiftStoreys, DOOR_SYMBOL } from './grundriss'

const AR = 0.5
const wall = (id: string, pts: BoardAnno['pts'], floor = 0): BoardAnno => ({ id, kind: 'draw', role: 'wand', floor, pts })
const door = (id: string, x: number, y: number, extra: Partial<BoardAnno> = {}): BoardAnno =>
  ({ id, kind: 'symbol', symbol: DOOR_SYMBOL, x, y, floor: 0, ...extra })
const isGb = (s: string) => s.startsWith('GB ')

describe('nearestWall', () => {
  const w = wall('w1', [[0.1, 0.5], [0.9, 0.5]])
  it('seats onto the nearest segment of a Wand on that storey, turned along it', () => {
    const s = nearestWall([w], 0, 0.4, 0.52, AR, 0.05)
    expect(s).toMatchObject({ wallId: 'w1', x: 0.4, y: 0.5, rotation: 0 })
  })
  it('reads the bearing in screen proportions (a vertical wall is 90°)', () => {
    const v = wall('v', [[0.5, 0.1], [0.5, 0.9]])
    expect(nearestWall([v], 0, 0.51, 0.3, AR, 0.05)?.rotation).toBe(90)
  })
  it('ignores walls out of reach, on another storey, and lines without the role', () => {
    expect(nearestWall([w], 0, 0.4, 0.8, AR, 0.05)).toBeNull()
    expect(nearestWall([w], 1, 0.4, 0.5, AR, 0.05)).toBeNull()
    expect(nearestWall([{ ...w, role: undefined }], 0, 0.4, 0.5, AR, 0.05)).toBeNull()
  })
})

describe('seatDoor', () => {
  it('lets go of the wall when there is no seat', () => {
    expect(seatDoor(door('d', 0.3, 0.3, { onWall: 'w1' }), null).onWall).toBeUndefined()
  })
})

describe('carryDoors', () => {
  const w = wall('w1', [[0.1, 0.5], [0.9, 0.5]])
  const d = door('d1', 0.3, 0.5, { onWall: 'w1', rotation: 0 })
  it('moves a door with its wall', () => {
    const moved = { ...w, pts: [[0.2, 0.6], [1, 0.6]] as BoardAnno['pts'] }
    const out = carryDoors([w, d], [moved, d], AR)
    expect(out[1]).toMatchObject({ y: 0.6, rotation: 0, onWall: 'w1' })
    expect(out[1].x).toBeCloseTo(0.4)
  })
  it('turns a door with its wall', () => {
    const turned = { ...w, pts: [[0.5, 0.1], [0.5, 0.9]] as BoardAnno['pts'] }
    const out = carryDoors([w, d], [turned, d], AR)
    expect(out[1].x).toBeCloseTo(0.5)
    expect(out[1].y).toBeCloseTo(0.3)
    expect(out[1].rotation).toBeCloseTo(90)
  })
  it('re-projects a door when a corner is added', () => {
    const bent = { ...w, pts: [[0.1, 0.5], [0.5, 0.5], [0.5, 0.9]] as BoardAnno['pts'] }
    const out = carryDoors([w, d], [bent, d], AR)
    expect(out[1].x).toBeCloseTo(0.3)
    expect(out[1].y).toBeCloseTo(0.5)
  })
  it('takes a door to the storey its wall moved to', () => {
    const up = { ...w, floor: 1 }
    expect(carryDoors([w, d], [up, d], AR)[1].floor).toBe(1)
  })
  it('frees the doors of a deleted wall', () => {
    expect(carryDoors([w, d], [d], AR)[0].onWall).toBeUndefined()
  })
  it('leaves a door the write itself moved, and returns the same list when nothing rides', () => {
    const own = { ...d, x: 0.7 }
    const moved = { ...w, pts: [[0.2, 0.6], [1, 0.6]] as BoardAnno['pts'] }
    expect(carryDoors([w, d], [moved, own], AR)[1]).toBe(own)
    const next = [w, d]
    expect(carryDoors([w, d], next, AR)).toBe(next)
  })
})

describe('copyGrundriss', () => {
  let n = 0
  const mint = (p: string) => `${p}-copy${++n}`
  const w = wall('w1', [[0.1, 0.5, 0], [0.9, 0.5, 0]])
  const flaeche: BoardAnno = { id: 'a1', kind: 'area', floor: 0, pts: [[0, 0], [0.2, 0], [0.2, 0.2]], label: 'Brandabschnitt' }
  const d = door('d1', 0.3, 0.5, { onWall: 'w1' })
  const stair: BoardAnno = { id: 's2', kind: 'symbol', symbol: 'GB Treppe 8', x: 0.8, y: 0.8, floor: 0, floorFrom: 0, floorTo: 1 }
  const leitung: BoardAnno = { id: 'l9', kind: 'draw', floor: 0, pts: [[0, 0], [1, 1]] }
  const feuer: BoardAnno = { id: 's9', kind: 'symbol', symbol: 'SL Feuer', x: 0.5, y: 0.5, floor: 0 }
  const otherFloor = wall('w2', [[0, 0], [1, 0]], 1)
  const annos = [w, flaeche, d, stair, leitung, feuer, otherFloor]

  it('copies only the Grundriss of the storey, as independent objects on each target', () => {
    const { added, counts } = copyGrundriss(annos, 0, [1, 2], isGb, mint)
    expect(counts).toEqual([{ floor: 1, n: 2 }, { floor: 2, n: 3 }])
    expect(added.every((a) => !annos.some((o) => o.id === a.id))).toBe(true)
    const on2 = added.filter((a) => a.floor === 2)
    expect(on2.map((a) => a.symbol ?? a.role).sort()).toEqual(['GB Treppe 8', DOOR_SYMBOL, 'wand'].sort())
    const w2 = on2.find((a) => a.role === 'wand')!
    expect(w2.pts!.every((p) => p[2] === 2)).toBe(true)
    expect(on2.find((a) => a.symbol === DOOR_SYMBOL)!.onWall).toBe(w2.id)
    expect(on2.find((a) => a.symbol === 'GB Treppe 8')).toMatchObject({ floorFrom: undefined, floorTo: undefined })
  })
  it('skips a ranged symbol that already stands on the target', () => {
    const { added } = copyGrundriss(annos, 0, [1], isGb, mint)
    expect(added.some((a) => a.symbol === 'GB Treppe 8')).toBe(false)
  })
})

describe('shiftStoreys', () => {
  it('moves the storey, every vertex storey and a range', () => {
    const l: BoardAnno = { id: 'l', kind: 'draw', floor: 0, pts: [[0, 0, 0], [1, 1, 1], [0.5, 0.5]] }
    expect(shiftStoreys(l, 1, [0, 1, 2])).toMatchObject({ floor: 1, pts: [[0, 0, 1], [1, 1, 2], [0.5, 0.5]] })
    const s: BoardAnno = { id: 's', kind: 'symbol', floor: 0, floorFrom: 0, floorTo: 1 }
    expect(shiftStoreys(s, 1, [0, 1, 2])).toMatchObject({ floor: 1, floorFrom: 1, floorTo: 2 })
  })
  it('refuses a shift that leaves the stack', () => {
    const l: BoardAnno = { id: 'l', kind: 'draw', floor: 0, pts: [[0, 0, 0], [1, 1, 1]] }
    expect(shiftStoreys(l, 1, [0, 1])).toBeNull()
    // a Treppe spanning the whole stack has nowhere to go, even though its own storey would
    const t: BoardAnno = { id: 't', kind: 'symbol', floor: 0, floorFrom: -1, floorTo: 1 }
    expect(shiftStoreys(t, 1, [-1, 0, 1])).toBeNull()
  })
})
