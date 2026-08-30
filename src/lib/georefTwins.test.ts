import { describe, it, expect } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import {
  TWIN_MAP_SYMBOLS, TWIN_MAP_VEHICLES,
  boardDrawingTwins, boardEntityTwins, boardSymbolToEntity, boardTwins, contentTwinName, entityToBoardSymbol, georefPlans, isTwinLayerId, mapContentTwins, mapTwinRows, mapTwins, movedTwinPath, onSheet, planAspect,
  planTwinRows, revealTwinLayer, twinPlanImageLayerId, twinPlanLayerId, twinVisible,
} from './georefTwins'
import type { StationPlanScales } from './stationPlanScale'
import type { BoardAnno, Drawing, Entity, PlanDocument } from '../types'

// A square sheet 100 m across, laid north-up over Oberwil: plan (0,0) is its top-left corner and
// plan (1,0) sits 100 m due east of it. Two pairs solve a similarity exactly, so every expectation
// below is arithmetic rather than a fitted approximation.
const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: mEast(100) },
]
const FIT = fitSimilarity(PAIRS, 1)!

const ent = (id: string, lngLat: { lng: number; lat: number }, over: Partial<Entity> = {}): Entity =>
  ({ id, kind: 'symbol', layer: 'taktisch', coord: [lngLat.lng, lngLat.lat], ...over })

const anno = (id: string, over: Partial<BoardAnno> = {}): BoardAnno =>
  ({ id, kind: 'symbol', x: 0.5, y: 0.5, ...over })

const plan = (id: string, over: Partial<PlanDocument> = {}): PlanDocument =>
  ({ id, code: id.toUpperCase(), title: id, subtitle: '', imageUrl: `/${id}.pdf`, orientation: 'portrait', ...over })

const scales = (over: Partial<StationPlanScales> = {}): StationPlanScales =>
  ({ default: null, byPlan: {}, georefByPlan: {}, ...over })

describe('planAspect', () => {
  it('prefers the per-incident calibration, then the station override, then the station default', () => {
    const p = plan('modul2')
    const st = scales({ byPlan: { modul2: { mPerU: 1, refM: 10, ar: 0.9 } }, default: { mPerU: 1, refM: 10, ar: 0.5 } })
    expect(planAspect(p, st, { mPerU: 1, refM: 10, ar: 1.3 })).toBe(1.3)
    expect(planAspect(p, st)).toBe(0.9)
    expect(planAspect(p, scales({ default: { mPerU: 1, refM: 10, ar: 0.5 } }))).toBe(0.5)
  })

  it('falls back to A4 by orientation when nothing has ever measured the sheet', () => {
    expect(planAspect(plan('m1'), scales())).toBeCloseTo(1 / 1.414, 6)
    expect(planAspect(plan('m1', { orientation: 'landscape' }), scales())).toBeCloseTo(1.414, 6)
  })

  it('takes a measured aspect over every stored one — that surface has seen the bitmap', () => {
    const st = scales({ byPlan: { m1: { mPerU: 1, refM: 10, ar: 0.9 } } })
    expect(planAspect(plan('m1'), st, undefined, 1.11)).toBe(1.11)
  })
})

describe('georefPlans', () => {
  const aspect1 = () => 1

  it('keeps only plans whose pairs actually solve', () => {
    const docs = [plan('linked'), plan('single'), plan('none')]
    const georefOf = (id: string) =>
      id === 'linked' ? { pairs: PAIRS }
      : id === 'single' ? { pairs: [PAIRS[0]] } // one pair fixes nothing but the translation
      : null
    expect(georefPlans(docs, georefOf, aspect1).map((p) => p.id)).toEqual(['linked'])
  })

  it('loads the concrete object sheet key rather than the reused Modul slot', () => {
    const seen: string[] = []
    const docs = [plan('modul2', { georefKey: 'object:obj-a:plan:modul2' })]
    const linked = georefPlans(docs, (key) => { seen.push(key); return { pairs: PAIRS } }, aspect1)
    expect(seen).toEqual(['object:obj-a:plan:modul2'])
    expect(linked).toHaveLength(1)
  })

  it('resolves several linked Modules independently and keeps their rail order', () => {
    const docs = [
      plan('modul1', { georefKey: 'object:obj-a:plan:modul1' }),
      plan('modul2-3', { georefKey: 'object:obj-a:plan:modul2-3' }),
      plan('modul5-wasser', { georefKey: 'object:obj-a:plan:modul5-wasser' }),
    ]
    const stored = new Map([
      ['object:obj-a:plan:modul1', { pairs: PAIRS }],
      ['object:obj-a:plan:modul2-3', { pairs: PAIRS }],
      ['object:obj-a:plan:modul5-wasser', { pairs: PAIRS }],
    ])
    const linked = georefPlans(docs, (key) => stored.get(key) ?? null, aspect1)
    expect(linked.map((p) => p.id)).toEqual(['modul1', 'modul2-3', 'modul5-wasser'])
  })

  it('never georeferences a floor stack or a viewer-only sheet', () => {
    const docs = [plan('gebaeude', { floorStack: true }), plan('pv', { viewer: true })]
    expect(georefPlans(docs, () => ({ pairs: PAIRS }), aspect1)).toEqual([])
  })
})

describe('mapTwins (plan → Karte)', () => {
  const linked = georefPlans([plan('modul2')], () => ({ pairs: PAIRS }), () => 1)

  it('projects plan symbols onto the map and names the plan they came from', () => {
    const twins = mapTwins(linked, { modul2: [anno('a1')] })
    expect(twins).toHaveLength(1)
    expect(twins[0]).toMatchObject({ planId: 'modul2', planCode: 'MODUL2', annoId: 'a1' })
    // the sheet's centre is 50 m east and 50 m south of its top-left corner
    expect(twins[0].coord[0]).toBeCloseTo(mEast(50).lng, 6)
    expect(twins[0].coord[1]).toBeLessThan(ORIGIN.lat)
  })

  it('mirrors symbols only — a hose line, a note and a Trupp chip belong to their own surface', () => {
    const board = { modul2: [anno('sym'), anno('line', { kind: 'draw' }), anno('note', { kind: 'text' }), anno('team', { kind: 'resource' })] }
    expect(mapTwins(linked, board).map((t) => t.annoId)).toEqual(['sym'])
  })

  it('skips an annotation with no anchor rather than putting it at the sheet corner', () => {
    expect(mapTwins(linked, { modul2: [anno('nowhere', { x: undefined, y: undefined })] })).toEqual([])
  })

  it('carries the sheet’s ground width on the plan record (reach conversion reads it)', () => {
    // the 100 m FIT at aspect 1 makes the ground width exactly 100
    expect(linked[0].widthM).toBeCloseTo(100, 3)
  })
})

// No twin size bands to pin any more (30.08.): twins are presentation-equivalent — each
// surface sizes them with its own native rule (mapView · symPx, Whiteboard · symBase).

describe('movedTwinPath (whole-object drag of a mirrored line/area)', () => {
  const pts: [number, number][] = [[0.1, 0.2], [0.5, 0.2], [0.5, 0.6]]

  it('translates every vertex by the same plan-space delta', () => {
    const out = movedTwinPath(pts, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.35 })
    const want = [[0.2, 0.25], [0.6, 0.25], [0.6, 0.65]]
    out.forEach((p, i) => { expect(p[0]).toBeCloseTo(want[i][0], 9); expect(p[1]).toBeCloseTo(want[i][1], 9) })
  })

  it('keeps a per-point floor untouched — the drag moves paper position, never storeys', () => {
    const out = movedTwinPath([[0.1, 0.2, 2], [0.5, 0.2, 3]], { x: 0, y: 0 }, { x: 0.1, y: 0 })
    expect(out.map((p) => p[2])).toEqual([2, 3])
  })

  it('clamps the DELTA to the sheet, so the shape stops at the edge instead of squashing', () => {
    const out = movedTwinPath(pts, { x: 0.3, y: 0.3 }, { x: 2, y: -2 })
    expect(out.map((p) => p[0].toFixed(3))).toEqual(['0.600', '1.000', '1.000'])
    expect(out.map((p) => p[1].toFixed(3))).toEqual(['0.000', '0.000', '0.400'])
  })
})

describe('contentTwinName', () => {
  it('uses the object’s own words first, then the kind’s tool name', () => {
    expect(contentTwinName({ kind: 'draw', label: 'Zufahrt' })).toBe('Zufahrt')
    expect(contentTwinName({ kind: 'text', text: 'Abschnitt Ost' })).toBe('Abschnitt Ost')
    expect(contentTwinName({ kind: 'draw' })).toBe('Linie')
    expect(contentTwinName({ kind: 'area' })).toBe('Fläche')
    expect(contentTwinName({ kind: 'note' })).toBe('Notiz')
    expect(contentTwinName({ kind: 'shape', shape: 'cloud' })).toBe('Rauch')
    expect(contentTwinName({ kind: 'team' })).toBe('Trupp')
  })
})

describe('mapContentTwins (plan → Karte)', () => {
  const linked = georefPlans([plan('modul2')], () => ({ pairs: PAIRS }), () => 1)

  it('projects lines, areas, notes, shapes and Atemschutz markers while symbols keep their interactive path', () => {
    const board = { modul2: [
      anno('line', { kind: 'draw', pts: [[0.1, 0.2], [0.8, 0.2]], x: undefined, y: undefined }),
      anno('area', { kind: 'area', pts: [[0.1, 0.1], [0.4, 0.1], [0.2, 0.4]], x: undefined, y: undefined }),
      anno('note', { kind: 'text', text: 'Notiz' }),
      anno('shape', { kind: 'shape', shape: 'cloud' }),
      anno('team', { kind: 'resource', text: 'Trupp 1' }),
      anno('symbol'),
    ] }
    const twins = mapContentTwins(linked, board)
    expect(twins.map((t) => t.annoId)).toEqual(['line', 'area', 'note', 'shape', 'team'])
    expect(twins.find((t) => t.annoId === 'line')?.coords).toHaveLength(2)
    expect(twins.find((t) => t.annoId === 'note')?.coord).toBeDefined()
  })
})

describe('onSheet / boardTwins (Karte → plan)', () => {
  it('tolerates a hair past the paper edge and nothing more', () => {
    expect(onSheet({ x: 0.5, y: 0.5 })).toBe(true)
    expect(onSheet({ x: -0.019, y: 1.019 })).toBe(true)
    expect(onSheet({ x: 1.05, y: 0.5 })).toBe(false)
    expect(onSheet({ x: 0.5, y: -0.4 })).toBe(false)
    expect(onSheet({ x: NaN, y: 0.5 })).toBe(false)
  })

  it('keeps what is on the sheet and DROPS what is two kilometres away', () => {
    const near = ent('near', mEast(50))
    const far = ent('far', mEast(2000))
    const twins = boardTwins([near, far], FIT, 'vehicle')
    expect(twins.map((t) => t.entityId)).toEqual(['near'])
    expect(twins[0].pt.x).toBeCloseTo(0.5, 3)
    expect(twins[0].kind).toBe('vehicle')
  })

  it('keys twins by kind, so a vehicle and a symbol with the same id never collide', () => {
    const e = ent('x', ORIGIN)
    expect(boardTwins([e], FIT, 'vehicle')[0].key).not.toBe(boardTwins([e], FIT, 'symbol')[0].key)
  })

  it('carries the source entity through untouched — a twin renders it, it never owns it', () => {
    const e = ent('v1', mEast(10), { kind: 'vehicle', label: 'TLF' })
    expect(boardTwins([e], FIT, 'vehicle')[0].entity).toBe(e)
  })
})

describe('broader Karte content → plan', () => {
  it('projects notes, shapes, Atemschutz markers and shared responder positions, clipping remote points', () => {
    const near = ['note', 'shape', 'team', 'person'].map((kind, i) => ent(kind, mEast(10 + i * 10), { kind: kind as Entity['kind'] }))
    const far = ent('far', mEast(2000), { kind: 'note' })
    expect(boardEntityTwins([...near, far], FIT).map((t) => t.entity.kind)).toEqual(['note', 'shape', 'team', 'person'])
  })

  it('drops a shared responder whose centre is only in the clip margin, avoiding a white edge crescent', () => {
    const justOutside = FIT.toMap({ x: -0.01, y: 0.5 })
    const person = ent('person-edge', justOutside, { kind: 'person', label: 'Degen André', live: true })
    const note = ent('note-edge', justOutside, { kind: 'note', label: 'Randnotiz' })
    expect(boardEntityTwins([person, note], FIT).map((t) => t.entity.id)).toEqual(['note-edge'])
  })

  it('projects lines and areas and turns a ground-radius circle into an area ring', () => {
    const drawings: Drawing[] = [
      { id: 'line', kind: 'line', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(40).lng, ORIGIN.lat]] },
      { id: 'area', kind: 'area', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat - 0.0001]] },
      { id: 'circle', kind: 'circle', coords: [[mEast(50).lng, ORIGIN.lat]], radiusM: 10 },
    ]
    const twins = boardDrawingTwins(drawings, FIT)
    expect(twins.map((t) => t.anno.kind)).toEqual(['draw', 'area', 'area'])
    expect(twins[2].anno.pts).toHaveLength(48)
    // the Pfeil's «Stopp» crosses the mirror with the arrow it belongs to
    const stopped = boardDrawingTwins([{ id: 's', kind: 'line', coords: drawings[0].coords, arrow: true, arrowStop: true }], FIT)
    expect(stopped[0].anno.arrowStop).toBe(true)
  })
})

describe('ownership transfer keeps one object', () => {
  it('moves a map symbol onto a plan with the same id and shared details', () => {
    const source = ent('e1', ORIGIN, { label: 'Feuer', floor: 2, fields: { Art: 'Dach' }, rotation: 18 })
    const moved = entityToBoardSymbol(source, { x: 0.3, y: 0.4 })
    expect(moved).toMatchObject({ id: 'e1', kind: 'symbol', x: 0.3, y: 0.4, label: 'Feuer', storey: 2, fields: { Art: 'Dach' }, rotation: 18 })
    expect(moved).not.toHaveProperty('coord')
    expect(moved).not.toHaveProperty('layer')
  })

  it('moves a plan symbol onto the map with the same id and storey badge', () => {
    const source = anno('a1', { label: 'Feuer', storey: -1, fields: { Art: 'Keller' } })
    const moved = boardSymbolToEntity(source, [7.5, 47.5], 'taktisch')
    expect(moved).toMatchObject({ id: 'a1', kind: 'symbol', coord: [7.5, 47.5], layer: 'taktisch', floor: -1, label: 'Feuer' })
    expect(moved).not.toHaveProperty('x')
    expect(moved).not.toHaveProperty('y')
  })

  it('does not transfer a live feed object as incident-owned data', () => {
    expect(entityToBoardSymbol(ent('gps', ORIGIN, { live: true }), { x: 0.5, y: 0.5 })).toBeNull()
  })

  // The Hubretter reach is metre-scaled on the map and a plan-width fraction on the sheet; the
  // 100 m FIT makes the factor exactly 100. Without the width the value is DROPPED, never
  // carried across as a number in the wrong unit.
  it('converts the Hubretter reach across the boundary, both ways', () => {
    const widthM = FIT.scaleMPerU * 1
    const toPlan = entityToBoardSymbol(ent('e1', ORIGIN, { reachM: 25 }), { x: 0.3, y: 0.4 }, widthM)
    expect(toPlan?.reachN).toBeCloseTo(0.25, 5)
    expect(toPlan).not.toHaveProperty('reachM')
    const toMap = boardSymbolToEntity(anno('a1', { reachN: 0.25 }), [7.5, 47.5], 'taktisch', widthM)
    expect(toMap?.reachM).toBeCloseTo(25, 3)
    expect(toMap).not.toHaveProperty('reachN')
    expect(entityToBoardSymbol(ent('e2', ORIGIN, { reachM: 25 }), { x: 0.3, y: 0.4 })?.reachN).toBeUndefined()
  })
})

describe('the Ebenen rows', () => {
  const linked = georefPlans([plan('modul2'), plan('modul3')], () => ({ pairs: PAIRS }), () => 1)

  it('gives every linked plan separate symbol and image rows on the Karte', () => {
    const rows = planTwinRows(linked, undefined, undefined)
    expect(rows.map((r) => r.id)).toEqual([
      twinPlanLayerId('modul2'), twinPlanImageLayerId('modul2'),
      twinPlanLayerId('modul3'), twinPlanImageLayerId('modul3'),
    ])
    expect(rows[0].label).toBe('Inhalte (MODUL2)')
    // two pairs solve exactly, so the row may not claim a measured residual
    expect(rows[0].sub).toBe('aus 2 Punkten')
    expect(rows.filter((r) => r.id.startsWith('twin:plan:')).every((r) => r.visible)).toBe(true)
    expect(rows.filter((r) => r.id.startsWith('twin:plan-image:')).every((r) => !r.visible)).toBe(true)
  })

  it('offers the two Karte rows on a linked sheet, and nothing at all on an unlinked one', () => {
    expect(mapTwinRows(linked[0].fit, undefined).map((r) => r.id)).toEqual([TWIN_MAP_VEHICLES, TWIN_MAP_SYMBOLS])
    expect(mapTwinRows(null, undefined)).toEqual([])
  })

  it('defaults ON and reflects a switched-off row', () => {
    expect(twinVisible(undefined, TWIN_MAP_VEHICLES)).toBe(true)
    expect(twinVisible({ [TWIN_MAP_VEHICLES]: false }, TWIN_MAP_VEHICLES)).toBe(false)
    expect(mapTwinRows(linked[0].fit, { [TWIN_MAP_SYMBOLS]: false }).find((r) => r.id === TWIN_MAP_SYMBOLS)?.visible).toBe(false)
  })

  it('reveals only the projection named by an explicit show jump', () => {
    const hidden = { [TWIN_MAP_SYMBOLS]: false, [TWIN_MAP_VEHICLES]: false }
    expect(revealTwinLayer(hidden, TWIN_MAP_SYMBOLS)).toEqual({
      [TWIN_MAP_SYMBOLS]: true,
      [TWIN_MAP_VEHICLES]: false,
    })
    const visible = { [TWIN_MAP_SYMBOLS]: true }
    expect(revealTwinLayer(visible, TWIN_MAP_SYMBOLS)).toBe(visible)
  })

  it('claims a measured residual only once a third pair has measured one', () => {
    // a third pair that does not fit perfectly — now there IS a residual to state
    const three = [...PAIRS, { plan: { x: 0.5, y: 0.5 }, lngLat: mEast(60) }]
    const [p] = georefPlans([plan('m2')], () => ({ pairs: three }), () => 1)
    expect(planTwinRows([p], undefined)[0].sub).toMatch(/^⌀ \d+\.\d\d m$/)
  })

  it('marks its ids as twin ids, so the panel can route the toggle', () => {
    expect(isTwinLayerId(twinPlanLayerId('modul2'))).toBe(true)
    expect(isTwinLayerId(TWIN_MAP_VEHICLES)).toBe(true)
    expect(isTwinLayerId('hydrant')).toBe(false)
  })
})
