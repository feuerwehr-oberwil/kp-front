import { describe, it, expect } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import {
  fitSignature, boardSymbolToEntity, contentTwinName, entityToBoardSymbol, georefPlans, isTwinLayerId, planAspect,
  planRasterRows, twinPlanImageLayerId, twinVisible,
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

  it('a raster row defaults OFF and reflects a switched-on one', () => {
    const id = twinPlanImageLayerId('modul2')
    expect(twinVisible(undefined, id)).toBe(true)      // the shared default…
    expect(planRasterRows(linked, undefined)[0].visible).toBe(false) // …but a sheet is opt-in
    expect(planRasterRows(linked, { [id]: true })[0].visible).toBe(true)
  })


  it('claims a measured residual only once a third pair has measured one', () => {
    // a third pair that does not fit perfectly — now there IS a residual to state
    const three = [...PAIRS, { plan: { x: 0.5, y: 0.5 }, lngLat: mEast(60) }]
    const [p] = georefPlans([plan('m2')], () => ({ pairs: three }), () => 1)
    expect(planRasterRows([p], undefined)[0].sub).toMatch(/^⌀ \d+\.\d\d m$/)
  })

  it('marks its ids as twin ids, so the panel can route the toggle', () => {
    expect(isTwinLayerId(twinPlanImageLayerId('modul2'))).toBe(true)
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
