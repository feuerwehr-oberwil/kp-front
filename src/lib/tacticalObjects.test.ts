import { describe, expect, it } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import {
  applyBoardToObjects, applyDocToObjects, bakeGeoBody, bakeSheetSymbol,
  objectsFromLegacy, sheetAnchoredIds, viewsOf, type TacticalObject,
} from './tacticalObjects'
import type { BoardAnno, Drawing, Entity } from '../types'

/* The unified tactical object (tmp/design-unified-objects.md, 09.09.2026): one record per
 * object; the sheet body's PRESENCE is the anchor. These tests pin the contract — the views
 * both surfaces render, the migration that heals transfer duplicates, the bake that makes a
 * record self-contained (a map body computed once through the fit, no fit at read time), and
 * the four readings the map seam gives a document that now contains those baked bodies. */

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

  it('a plan-only incident has a map scene — which is what un-disables the Kroki', () => {
    // the Kroki payload and its toggle are built from `entities + drawings` (IncidentWorkspace ·
    // mapContentCount / scene). Plan-drawn work never reached either of them while the map view
    // was anchor-only; a baked body IS that scene now, for a Rapport with no Karte work at all.
    const objects = [
      bakeGeoBody({ id: 's1', sheet: { planId: 'modul2', anno: anno('s1') } }, PLAN, 'taktisch'),
      bakeGeoBody({ id: 'l1', sheet: { planId: 'modul2', anno: anno('l1', { kind: 'draw', x: undefined, y: undefined, pts: [[0, 0], [1, 1]] }) } }, PLAN, 'taktisch'),
    ]
    const views = viewsOf(objects)
    expect(views.entities).toHaveLength(1)
    expect(views.drawings).toHaveLength(1)
    expect(views.board.modul2).toHaveLength(2)
  })

  it('heals a transfer duplicate into ONE object — the sheet placement wins the anchor', () => {
    // the old delete+add transfer could be resurrected on both sides by a concurrent merge
    const objects = objectsFromLegacy([ent('x1')], [], { modul2: [anno('x1')] })
    expect(objects).toHaveLength(1)
    expect(objects[0].sheet?.planId).toBe('modul2')
    expect(objects[0].entity?.id).toBe('x1')
    // …and it renders on BOTH surfaces from that ONE record: the sheet draws its anno, the
    // Karte its map body. Two pictures of one object is the point; two records was the bug.
    const views = viewsOf(objects)
    expect(views.entities.map((e) => e.id)).toEqual(['x1'])
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

  /* The Karte hands back a document that CONTAINS the baked bodies of sheet-anchored objects,
   * so applyDocToObjects has to read it as a gesture. Four readings, one per branch. */
  describe('a Karte edit of a sheet-anchored object', () => {
    const sheetStore = (over: Partial<BoardAnno> = {}): TacticalObject[] =>
      [bakeGeoBody({ id: 's1', sheet: { planId: 'modul2', anno: anno('s1', { x: 0.5, y: 0, ...over }) } }, PLAN, 'taktisch')]

    const backFromMap = (objects: TacticalObject[], patch: Partial<Entity>) =>
      applyDocToObjects(objects, { entities: [{ ...objects[0].entity!, ...patch }], drawings: [] })

    it('MOVED on the map → the anchor flips: the sheet body is dropped', () => {
      const next = backFromMap(sheetStore(), { coord: mEastCoord(300) })
      expect(next[0].sheet).toBeUndefined()
      expect(next[0].entity!.coord).toEqual(mEastCoord(300))
      expect(viewsOf(next).board.modul2).toBeUndefined() // it has left that sheet
    })

    it('RE-STYLED only → the sheet keeps the anchor and the edit lands on the anno', () => {
      const next = backFromMap(sheetStore(), { label: 'Brandherd', color: '#f00', count: 3 })
      expect(next[0].sheet?.planId).toBe('modul2')
      expect(next[0].sheet?.anno).toMatchObject({ label: 'Brandherd', color: '#f00', count: 3, x: 0.5, y: 0 })
    })

    it('…and that edit SURVIVES the next bake, which is the whole reason it lands there', () => {
      const edited = backFromMap(sheetStore(), { label: 'Brandherd', rotation: 90 })
      const rebaked = bakeGeoBody(edited[0], PLAN, 'taktisch')
      expect(rebaked.entity).toMatchObject({ label: 'Brandherd', rotation: 90 })
      expect(rebaked.entity!.coord[0]).toBeCloseTo(mEast(50).lng, 8) // …and the sheet still says where
    })

    it('the map badge crosses under the sheet’s own name for it', () => {
      // Entity.floor is BoardAnno.storey — the one rename the transfer converters have always
      // made, and the reason a floor edit does not silently revert on the next bake
      const next = backFromMap(sheetStore(), { floor: -1 })
      expect(next[0].sheet?.anno.storey).toBe(-1)
      expect(bakeGeoBody(next[0], PLAN, 'taktisch').entity?.floor).toBe(-1)
    })

    it('GONE from the document → the whole object goes, sheet body and all', () => {
      const next = applyDocToObjects(sheetStore(), { entities: [], drawings: [] })
      expect(next).toEqual([])
    })

    it('…but an object with no baked body was never on the Karte to delete', () => {
      const unbaked: TacticalObject[] = [{ id: 's1', sheet: { planId: 'modul2', anno: anno('s1') } }]
      expect(applyDocToObjects(unbaked, { entities: [], drawings: [] })).toEqual(unbaked)
    })

    it('the bake PRESERVES what only the Karte has a word for', () => {
      // a re-derived body replaced everything the sheet cannot say — a note's dragged width,
      // a label's georeferenced anchor, an Abschnitt's Leiter — every single bake
      const o = bakeGeoBody({ id: 'n1', sheet: { planId: 'modul2', anno: anno('n1', { kind: 'text', text: 'Zugang' }) } }, PLAN, 'taktisch')
      const widened = { ...o, entity: { ...o.entity!, noteW: 240 } }
      expect(bakeGeoBody(widened, PLAN, 'taktisch').entity?.noteW).toBe(240)
    })

    it('a reshaped plan LINE flips the anchor; a re-coloured one does not', () => {
      const line = bakeGeoBody(
        { id: 'l1', sheet: { planId: 'modul2', anno: anno('l1', { kind: 'draw', x: undefined, y: undefined, pts: [[0, 0], [1, 0]] }) } },
        PLAN, 'taktisch',
      )
      const styled = applyDocToObjects([line], { entities: [], drawings: [{ ...line.drawing!, color: '#0f0', lineNo: 2 }] })
      expect(styled[0].sheet?.anno).toMatchObject({ color: '#0f0', lineNo: 2 })
      const reshaped = applyDocToObjects([line], { entities: [], drawings: [{ ...line.drawing!, coords: [mEastCoord(0), mEastCoord(400)] }] })
      expect(reshaped[0].sheet).toBeUndefined()
    })
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

  it('the anno list ORDER is the store order — a «nach vorne» on the sheet round-trips', () => {
    const objs = applyBoardToObjects([], 'modul2', [anno('a'), anno('b'), anno('c')])
    const reordered = applyBoardToObjects(objs, 'modul2', [anno('b'), anno('c'), anno('a')])
    expect(viewsOf(reordered).board.modul2.map((a) => a.id)).toEqual(['b', 'c', 'a'])
  })

  it('one plan is re-seated in its own slots — the map objects around it do not move', () => {
    const start = objectsFromLegacy([ent('e1')], [], { modul2: [anno('a1')] }).concat(
      objectsFromLegacy([ent('e2')], [], {}),
    )
    const next = applyBoardToObjects(start, 'modul2', [anno('a1', { x: 0.9 }), anno('a2')])
    // e1 … a1 … e2 … a2 — the Karte's own paint order is untouched by a plan edit
    expect(next.map((o) => o.id)).toEqual(['e1', 'a1', 'e2', 'a2'])
  })

  it('handing a map object to a plan list flips its anchor to the sheet', () => {
    const next = applyBoardToObjects(store(), 'modul2', [anno('a1'), anno('e1')])
    const flipped = next.find((o) => o.id === 'e1')!
    expect(flipped.sheet?.planId).toBe('modul2') // the sheet is its truth from here on
    // it still shows on the Karte — as a BAKED body now, which the next bake re-derives from
    // the anno; what changed is which surface a move has to be written back to
    expect(viewsOf(next).board.modul2?.map((a) => a.id)).toEqual(['a1', 'e1'])
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

describe('sheetAnchoredIds — a sheet is never lent its own objects', () => {
  /* ⚠️ The regression this exists for: the Karte draws a plan-drawn symbol itself now, so it
   * is an ordinary entity — and the map→plan mirror, which is still a projection, handed it
   * straight back to the sheet it was drawn on. It appeared TWICE on its own Modul (its anno
   * plus a twin of its own baked body) and printed twice. */
  const store = (): TacticalObject[] => [
    bakeGeoBody({ id: 's1', sheet: { planId: 'modul2', anno: anno('s1') } }, PLAN, 'taktisch'),
    { id: 'm1', entity: ent('m1') },
  ]

  it('names exactly the ids anchored on that plan', () => {
    expect([...sheetAnchoredIds(store(), 'modul2')]).toEqual(['s1'])
    expect([...sheetAnchoredIds(store(), 'modul3')]).toEqual([]) // …and nothing on a sibling sheet
  })

  it('the Karte entity list minus that set is what the sheet may be lent', () => {
    const objects = store()
    const own = sheetAnchoredIds(objects, 'modul2')
    const lent = viewsOf(objects).entities.filter((e) => !own.has(e.id))
    expect(lent.map((e) => e.id)).toEqual(['m1']) // the map's own object crosses; the sheet's does not
  })
})
