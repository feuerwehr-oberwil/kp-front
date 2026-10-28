import { describe, expect, it } from 'vitest'
import type { BoardAnno, Drawing, Trupp } from '../types'
import { carryDoors, copyGrundriss, grundrissKinds, nearestWall, seatDoor, shiftStoreys, spansStoreys, wallRolePatch, wallRoleWire, wandBlock, DOOR_SYMBOL } from './grundriss'

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

describe('grundrissKinds', () => {
  it('counts the Wände and each Gebäude symbol, in the order they first appear', () => {
    const items = [door('d1', 0, 0), wall('w1', [[0, 0], [1, 0]]), { ...door('t', 0, 0), symbol: 'GB Treppe 8' }, door('d2', 0, 0), wall('w2', [[0, 1], [1, 1]])]
    expect(grundrissKinds(items)).toEqual({ walls: 2, symbols: [{ symbol: DOOR_SYMBOL, n: 2 }, { symbol: 'GB Treppe 8', n: 1 }] })
  })
})

describe('spansStoreys', () => {
  it('is true only when a vertex sits on another storey than the line', () => {
    expect(spansStoreys(wall('a', [[0.1, 0.1, 1], [0.5, 0.1, 1]], 1))).toBe(false)
    expect(spansStoreys(wall('b', [[0.1, 0.1], [0.5, 0.1]], 1))).toBe(false)
    expect(spansStoreys(wall('c', [[0.1, 0.1, 0], [0.5, 0.1, 1]], 0))).toBe(true)
  })
})

const ink = { color: '#1f6feb', width: 5 }

describe('wallRolePatch', () => {
  const look = { color: '#111', width: 2 }
  const hose: BoardAnno = { id: 'l', kind: 'draw', floor: 0, pts: [[0, 0], [1, 0]], color: '#1f6feb', width: 5, dashed: true, arrow: true, marker: 'R', content: 'S', lineNo: 3, teilstueck: true }
  const apply = (a: BoardAnno, p: Partial<BoardAnno>) => ({ ...a, ...p })

  it('a Linie becomes a Wand: the Wand look, no hose fields, the points kept', () => {
    const w = apply(hose, wallRolePatch(hose, true, look, ink))
    expect(w).toMatchObject({ role: 'wand', color: '#111', width: 2, pts: hose.pts })
    for (const k of ['dashed', 'arrow', 'marker', 'content', 'lineNo', 'teilstueck'] as const) expect(w[k]).toBeUndefined()
    expect(apply(hose, wallRolePatch(hose, true, look, ink, true)).teilstueck).toBe(true)
  })

  // lead call 28.10.2026: the Wand's 2 px is below any width the editor offers – back to the default
  it('a Wand becomes a Linie: the default width, and the default colour unless recoloured', () => {
    const w = wall('w', [[0, 0], [1, 0]])
    expect(apply({ ...w, ...look }, wallRolePatch({ ...w, ...look }, false, look, ink))).toMatchObject({ role: undefined, color: '#1f6feb', width: 5 })
    expect(apply({ ...w, color: '#e8392b' }, wallRolePatch({ ...w, color: '#e8392b' }, false, look, ink)).color).toBe('#e8392b')
  })

  it('a Durchgang on it lets go once it is no Wand (carryDoors)', () => {
    const w = wall('w1', [[0.1, 0.5], [0.9, 0.5]])
    const d = door('d1', 0.5, 0.5, { onWall: 'w1' })
    const out = carryDoors([w, d], [{ ...w, ...wallRolePatch(w, false, look, ink) }, d], AR)
    expect(out[1]).toMatchObject({ x: 0.5, y: 0.5, onWall: undefined })
  })
})

// sweep 28.10.2026: the «Art» row on every Plan sheet and on the Karte asks ONE rule
describe('wandBlock', () => {
  const trupp = { id: 't1', name: 'Trupp 1', status: 'aktiv', entryPressureBar: 300, entryTime: '', lastContactTime: '', lineId: 'l1' } satisfies Trupp
  const linie: BoardAnno = { id: 'l1', kind: 'draw', floor: 0, pts: [[0, 0], [1, 0]] }

  it('a Trupp on the line blocks it – by anchor or by Leitung Nr.', () => {
    expect(wandBlock(linie, [trupp], linie)).toBe('trupp')
    expect(wandBlock({ id: 'x', lineNo: 2 }, [{ ...trupp, lineId: undefined, lineNo: 2 }])).toBe('trupp')
  })

  it('a stack line that climbs is blocked; a flat sheet or a Karte line never climbs', () => {
    const climbs: BoardAnno = { ...linie, id: 'c', pts: [[0, 0, 0], [1, 0, 1]] }
    expect(wandBlock(climbs, [], climbs)).toBe('storeys')
    expect(wandBlock(linie, [], linie)).toBeNull()
    expect(wandBlock({ id: 'k' }, [])).toBeNull()
  })

  it('a Wand may always go back to a Linie', () => {
    expect(wandBlock({ ...linie, role: 'wand' }, [trupp], linie)).toBeNull()
  })
})

describe('wallRolePatch on a Karte line, and its wire', () => {
  const look = { color: '#111', width: 2 }
  const hose: Drawing = { id: 'k1', kind: 'line', coords: [[7.6, 47.5], [7.61, 47.5]], color: '#1f6feb', width: 4, arrow: true, marker: 'R', lineNo: 2, content: 'S' }

  it('is the same patch on a Drawing: the Wand look, no hose decor, coords kept', () => {
    const w: Drawing = { ...hose, ...wallRolePatch(hose, true, look, ink) }
    expect(w).toMatchObject({ role: 'wand', color: '#111', width: 2, coords: hose.coords })
    for (const k of ['arrow', 'marker', 'lineNo', 'content'] as const) expect(w[k]).toBeUndefined()
  })

  it('sends every cleared field as null – JSON would drop an undefined', () => {
    expect(JSON.parse(JSON.stringify(wallRoleWire(wallRolePatch(hose, false, look, ink))))).toEqual({ role: null, width: 5 })
    expect(JSON.parse(JSON.stringify(wallRoleWire(wallRolePatch(hose, true, look, ink))))).toMatchObject({ role: 'wand', arrow: null, lineNo: null, content: null })
  })
})
