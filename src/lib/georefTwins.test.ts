import { describe, it, expect } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import {
  TWIN_MAP_SYMBOLS, TWIN_MAP_VEHICLES,
  boardTwinAnnosForPrint, boardDrawingTwins, fitSignature, boardEntityTwins, boardSymbolToEntity, boardTwins, contentTwinName, entityToBoardSymbol, georefPlans, isTwinLayerId, mapTwinRows, onSheet, planAspect,
  planRasterRows, revealTwinLayer, twinPlanImageLayerId, twinVisible,
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

describe('boardTwinAnnosForPrint (mirrored Karte content on the exported Objektplan page)', () => {
  const gp = { id: 'modul2', code: 'M2', title: 'Modul 2', fit: FIT, widthM: 100 }
  const mid = mEast(50)

  it('projects symbols, drawings, notes, shapes and Trupp chips into printable annos', () => {
    const entities: Entity[] = [
      ent('f', mid, { symbol: 'Feuer' }),
      ent('n', mid, { kind: 'note', label: 'Abschnitt West' }),
      ent('s', mid, { kind: 'shape', shape: 'square', sizeM: 20, rotation: 10 }),
      ent('t', mid, { kind: 'team', label: 'Trupp 1', color: '#e8392b', trail: [{ coord: [mid.lng, mid.lat], t: '15:34' }] }),
    ]
    const drawings: Drawing[] = [{ id: 'l', kind: 'line', coords: [[ORIGIN.lng, ORIGIN.lat], [mid.lng, mid.lat]] }]
    const out = boardTwinAnnosForPrint(gp, entities, drawings)
    const byKind = Object.fromEntries(out.map((a) => [a.kind, a]))
    expect(out).toHaveLength(5)
    expect(byKind.symbol.x).toBeCloseTo(0.5, 3)
    expect(byKind.symbol.id).toBe('twin-f')                        // never collides with a sheet anno
    expect(byKind.text.text).toBe('Abschnitt West')
    expect(byKind.shape.sizeN).toBeCloseTo(0.2, 3)                 // 20 m on a 100 m sheet
    expect(byKind.resource.trail?.[0]?.x).toBeCloseTo(0.5, 3)      // the Truppverfolgung prints too
    expect(byKind.draw.pts).toHaveLength(2)
  })

  it('drops live entities and everything standing off the sheet', () => {
    const out = boardTwinAnnosForPrint(gp, [
      ent('v', mid, { live: true, symbol: 'Fahrzeug' }),
      ent('far', mEast(5000), { symbol: 'Feuer' }),
    ], [])
    expect(out).toEqual([])
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

  // D-07: the lock is a property of the OBJECT. Without it on the projection a Fläche locked on
  // the Karte was still draggable through its mirror on the Plan.
  it('carries the source’s lock across, so the mirror refuses the same gestures', () => {
    const twins = boardDrawingTwins([
      { id: 'sektor', kind: 'area', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat - 0.0001]], locked: true },
      { id: 'frei', kind: 'line', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(40).lng, ORIGIN.lat]] },
    ], FIT)
    expect(twins.map((t) => t.anno.locked)).toEqual([true, undefined])
  })

  // D-17: Schraffur is FKS meaning («betroffene Fläche»), not decoration — dropping it changes
  // what the mirror says about the ground, not merely how it looks.
  it('carries the Schraffur across', () => {
    const twins = boardDrawingTwins([
      { id: 'betroffen', kind: 'area', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat - 0.0001]], hatch: true },
      { id: 'gewaschen', kind: 'area', coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat], [mEast(20).lng, ORIGIN.lat - 0.0001]] },
    ], FIT)
    expect(twins.map((t) => t.anno.hatch)).toEqual([true, undefined])
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

  it('gives every linked plan ONE row on the Karte — its sheet, opt-in under the ink', () => {
    // the symbols that stand on the sheet need no row of their own: they are ordinary map
    // objects now and answer to the Ebene they were placed on
    const rows = planRasterRows(linked, undefined, undefined)
    expect(rows.map((r) => r.id)).toEqual([twinPlanImageLayerId('modul2'), twinPlanImageLayerId('modul3')])
    expect(rows[0].label).toBe('Plan (MODUL2)')
    // two pairs solve exactly, so the row may not claim a measured residual
    expect(rows[0].sub).toBe('aus 2 Punkten')
    expect(rows.every((r) => !r.visible)).toBe(true)
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
    expect(planRasterRows([p], undefined)[0].sub).toMatch(/^⌀ \d+\.\d\d m$/)
  })

  it('marks its ids as twin ids, so the panel can route the toggle', () => {
    expect(isTwinLayerId(twinPlanImageLayerId('modul2'))).toBe(true)
    expect(isTwinLayerId(TWIN_MAP_VEHICLES)).toBe(true)
    expect(isTwinLayerId('hydrant')).toBe(false)
  })
})

describe('fitSignature — «was the georeference corrected, or did the memo just run again?»', () => {
  const of = (pairs: GeorefPair[], aspect = 1) => georefPlans([plan('modul2')], () => ({ pairs }), () => aspect)[0]

  it('two solves of the SAME pairs sign identically — a re-render is not a correction', () => {
    expect(fitSignature(of(PAIRS))).toBe(fitSignature(of(PAIRS)))
  })

  it('…and a moved pair, a turned sheet or a different aspect all change it', () => {
    const base = fitSignature(of(PAIRS))
    expect(fitSignature(of([PAIRS[0], { plan: { x: 1, y: 0 }, lngLat: mEast(200) }]))).not.toBe(base)
    expect(fitSignature(of(PAIRS, 1.5))).not.toBe(base)
  })
})
