import { describe, expect, it } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import {
  applyBoardToObjects, applyDocToObjects, bakeGeoBody, bakeSheetSymbol,
  objectsFromLegacy, viewsOf, type TacticalObject,
} from './tacticalObjects'
import type { BoardAnno, Drawing, Entity } from '../types'

/* The unified tactical object (tmp/design-unified-objects.md, 09.09.2026): one record per
 * object; the sheet body's PRESENCE is the anchor. These tests pin the phase-1 contract —
 * views render-identical to the three legacy collections, the migration heals transfer
 * duplicates, the doc/board seams keep whole-object delete semantics, and the bake makes
 * the record self-contained (a map body computed once through the fit, no fit at read time). */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: mEast(100) },
]
const FIT = fitSimilarity(PAIRS, 1)!
const PLAN = { fit: FIT, aspect: 1 }

const ent = (id: string, over: Partial<Entity> = {}): Entity =>
  ({ id, kind: 'symbol', layer: 'taktisch', coord: [ORIGIN.lng, ORIGIN.lat], ...over })
const drw = (id: string, over: Partial<Drawing> = {}): Drawing =>
  ({ id, kind: 'line', coords: [[ORIGIN.lng, ORIGIN.lat], mEastCoord(50)], ...over })
const anno = (id: string, over: Partial<BoardAnno> = {}): BoardAnno =>
  ({ id, kind: 'symbol', x: 0.5, y: 0.5, ...over })
function mEastCoord(m: number): [number, number] { const p = mEast(m); return [p.lng, p.lat] }

describe('objectsFromLegacy + viewsOf — the round trip', () => {
  it('splits the three collections into objects and derives them back unchanged', () => {
    const entities = [ent('e1'), ent('e2', { kind: 'note', label: 'Zugang' })]
    const drawings = [drw('d1')]
    const board = { modul2: [anno('a1')], modul3: [anno('a2', { kind: 'text', text: 'Keller' })] }
    const objects = objectsFromLegacy(entities, drawings, board)
    expect(objects).toHaveLength(5)
    const views = viewsOf(objects)
    expect(views.entities).toEqual(entities)
    expect(views.drawings).toEqual(drawings)
    expect(views.board).toEqual(board)
  })

  it('heals a transfer duplicate into ONE object — the sheet placement wins the anchor', () => {
    // the old delete+add transfer could be resurrected on both sides by a concurrent merge
    const objects = objectsFromLegacy([ent('x1')], [], { modul2: [anno('x1')] })
    expect(objects).toHaveLength(1)
    expect(objects[0].sheet?.planId).toBe('modul2')
    expect(objects[0].entity?.id).toBe('x1')
    // …and the views show it ONCE, on the sheet it was placed on
    const views = viewsOf(objects)
    expect(views.entities).toEqual([])
    expect(views.board.modul2).toHaveLength(1)
  })
})

describe('the setDoc / setBoard seams', () => {
  const store = (): TacticalObject[] => objectsFromLegacy(
    [ent('e1')], [drw('d1')], { modul2: [anno('a1')] },
  )

  it('applyDocToObjects replaces the geo-anchored objects and never touches sheet ones', () => {
    const moved = ent('e1', { coord: mEastCoord(30) })
    const next = applyDocToObjects(store(), { entities: [moved], drawings: [drw('d1')] })
    expect(viewsOf(next).entities).toEqual([moved])
    expect(viewsOf(next).board.modul2).toHaveLength(1)
  })

  it('a geo id missing from the document deletes the WHOLE object', () => {
    const next = applyDocToObjects(store(), { entities: [], drawings: [] })
    expect(next.map((o) => o.id)).toEqual(['a1'])
  })

  it('live overlays never become records', () => {
    const next = applyDocToObjects([], { entities: [ent('v1', { live: true })], drawings: [] })
    expect(next).toEqual([])
  })

  it('applyBoardToObjects updates one plan and leaves every other object standing', () => {
    const movedAnno = anno('a1', { x: 0.9 })
    const next = applyBoardToObjects(store(), 'modul2', [movedAnno, anno('a9')])
    const views = viewsOf(next)
    expect(views.board.modul2).toEqual([movedAnno, anno('a9')])
    expect(views.entities).toHaveLength(1)
    expect(views.drawings).toHaveLength(1)
  })

  it('an anno id missing from the plan list deletes the whole object', () => {
    const next = applyBoardToObjects(store(), 'modul2', [])
    expect(next.map((o) => o.id).sort()).toEqual(['d1', 'e1'])
  })

  it('handing a map object to a plan list flips its anchor to the sheet', () => {
    const next = applyBoardToObjects(store(), 'modul2', [anno('a1'), anno('e1')])
    const flipped = next.find((o) => o.id === 'e1')!
    expect(flipped.sheet?.planId).toBe('modul2')
    expect(viewsOf(next).entities).toEqual([]) // it now materializes on the sheet
  })
})

describe('bakeGeoBody — the write-through that makes the record self-contained', () => {
  it('bakes a sheet symbol to the geo position its projection shows', () => {
    const o: TacticalObject = { id: 's1', sheet: { planId: 'modul2', anno: anno('s1', { x: 0.5, y: 0, storey: 2 }) } }
    const baked = bakeGeoBody(o, PLAN, 'taktisch')
    expect(baked.entity?.kind).toBe('symbol')
    expect(baked.entity?.floor).toBe(2)
    expect(baked.entity!.coord[0]).toBeCloseTo(mEast(50).lng, 8)
    expect(baked.entity!.coord[1]).toBeCloseTo(ORIGIN.lat, 8)
    // the sheet body stays the anchor — baking adds a body, it never moves the truth
    expect(baked.sheet).toEqual(o.sheet)
  })

  it('bakes a plan line vertex-by-vertex and carries the FKS annotations', () => {
    const o: TacticalObject = {
      id: 'l1',
      sheet: { planId: 'modul2', anno: anno('l1', { kind: 'draw', x: undefined, y: undefined, pts: [[0, 0], [1, 0]], lineNo: 2, content: 'S', width: 5 }) },
    }
    const baked = bakeGeoBody(o, PLAN, 'taktisch')
    expect(baked.drawing?.kind).toBe('line')
    expect(baked.drawing?.lineNo).toBe(2)
    expect(baked.drawing?.content).toBe('S')
    expect(baked.drawing!.coords[1][0]).toBeCloseTo(mEast(100).lng, 8)
  })

  it('converts a circle radius from plan fraction to metres', () => {
    const o: TacticalObject = { id: 'c1', sheet: { planId: 'modul2', anno: anno('c1', { kind: 'circle', radiusN: 0.25 }) } }
    const baked = bakeGeoBody(o, PLAN, 'taktisch')
    expect(baked.drawing?.radiusM).toBeCloseTo(25, 3) // 0.25 of a 100 m sheet
  })

  it('bakes a Trupp chip into the map team marker, trail and all', () => {
    // the chip and the map's team marker are ONE object — without this the plan-placed Trupp
    // would simply vanish from the Karte, and its recorded breadcrumbs with it
    const o: TacticalObject = {
      id: 'r1',
      sheet: { planId: 'modul2', anno: anno('r1', {
        kind: 'resource', x: 0.5, y: 0, text: 'Trupp 1', color: '#f00', truppId: 't7', t: '10:15',
        trail: [{ x: 0, y: 0, t: '10:00' }, { x: 1, y: 0, t: '10:15' }],
      }) },
    }
    const baked = bakeGeoBody(o, PLAN, 'taktisch')
    expect(baked.entity?.kind).toBe('team')
    expect(baked.entity?.label).toBe('Trupp 1')
    expect(baked.entity?.truppId).toBe('t7')
    expect(baked.entity?.t).toBe('10:15')
    expect(baked.entity?.color).toBe('#f00')
    expect(baked.entity!.coord[0]).toBeCloseTo(mEast(50).lng, 8)
    expect(baked.entity?.trail).toHaveLength(2)
    expect(baked.entity!.trail![1].coord[0]).toBeCloseTo(mEast(100).lng, 8)
    expect(baked.entity!.trail![0].t).toBe('10:00')
    // …and the sheet stays the anchor, as for every other kind
    expect(baked.sheet).toEqual(o.sheet)
  })

  it('a chip that has never moved bakes without a trail', () => {
    const o: TacticalObject = { id: 'r2', sheet: { planId: 'modul2', anno: anno('r2', { kind: 'resource', text: 'Trupp 2' }) } }
    expect(bakeGeoBody(o, PLAN, 'taktisch').entity?.trail).toBeUndefined()
  })

  it('without a fit the object stays sheet-only — honestly absent from the map', () => {
    const o: TacticalObject = { id: 's1', sheet: { planId: 'modul2', anno: anno('s1') } }
    expect(bakeGeoBody(o, undefined, 'taktisch')).toBe(o)
  })
})

describe('bakeSheetSymbol — the drag-onto-the-sheet door', () => {
  it('creates the sheet body at the drop point and keeps one id', () => {
    const o: TacticalObject = { id: 'e1', entity: ent('e1', { floor: 1, reachM: 25 }) }
    const baked = bakeSheetSymbol(o, 'modul2', { x: 0.25, y: 0.75 }, PLAN)!
    expect(baked.sheet?.planId).toBe('modul2')
    expect(baked.sheet?.anno.id).toBe('e1')
    expect(baked.sheet?.anno.storey).toBe(1)
    expect(baked.sheet?.anno.reachN).toBeCloseTo(0.25, 5)
  })

  it('refuses a live vehicle — an overlay is not a record', () => {
    const o: TacticalObject = { id: 'v1', entity: ent('v1', { live: true }) }
    expect(bakeSheetSymbol(o, 'modul2', { x: 0.5, y: 0.5 }, PLAN)).toBeNull()
  })
})
