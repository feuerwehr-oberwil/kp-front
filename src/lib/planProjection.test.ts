import { describe, expect, it } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import { liveOverlay, projectOnto, projectedAnnos } from './planProjection'
import { applyBoardToObjects, bakeGeoBody, viewsOf, type PlanFit, type TacticalObject } from './tacticalObjects'
import { SHAPE_DEFS } from './shapes'
import type { Drawing, Entity } from '../types'

/* The Karte in one sheet's own words. This is the mirror of `bakeGeoBody`, and the pair has to
 * stay inverse: a projected anno that comes back off the sheet becomes the object's stored sheet
 * body verbatim, so anything this derivation does that the bake does not undo would rotate,
 * resize or displace the object a little on every anchor flip. */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const coordEast = (m: number): [number, number] => { const p = mEast(m); return [p.lng, p.lat] }
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: mEast(100) },
]
const PLAN: PlanFit = { fit: fitSimilarity(PAIRS, 1)!, aspect: 1 }

const ent = (over: Partial<Entity> & { id: string }): Entity =>
  ({ kind: 'symbol', layer: 'taktisch', coord: [ORIGIN.lng, ORIGIN.lat], ...over })
const geo = (e: Entity): TacticalObject => ({ id: e.id, entity: e })
const drawn = (d: Drawing): TacticalObject => ({ id: d.id, drawing: d })

describe('projectOnto — what a sheet shows of the Karte', () => {
  it('puts a map symbol at its place on the paper, under its own id', () => {
    const a = projectOnto(geo(ent({ id: 'e1', symbol: 'Feuer', label: 'Brandherd', coord: coordEast(50) })), PLAN)!
    expect(a.id).toBe('e1') // the SAME object — that is what lets an edit be matched back
    expect(a.kind).toBe('symbol')
    expect(a.label).toBe('Brandherd')
    expect(a.x).toBeCloseTo(0.5, 6)
    expect(a.y).toBeCloseTo(0, 6)
  })

  it('drops what is not on the sheet, and keeps what is a hair past its edge', () => {
    expect(projectOnto(geo(ent({ id: 'far', coord: coordEast(2000) })), PLAN)).toBeNull()
    expect(projectOnto(geo(ent({ id: 'edge', coord: coordEast(101) })), PLAN)).not.toBeNull()
  })

  it('shows nothing of an object anchored on a sheet — plan A never clutters plan B', () => {
    const onSheet: TacticalObject = { id: 's1', sheet: { planId: 'modul3', anno: { id: 's1', kind: 'symbol', x: 0.5, y: 0.5 } } }
    expect(projectOnto(onSheet, PLAN)).toBeNull()
  })

  it('a live vehicle is a moment, not a record — it is no part of the document', () => {
    expect(projectOnto(geo(ent({ id: 'v1', live: true })), PLAN)).toBeNull()
    expect(liveOverlay([ent({ id: 'v1', live: true, coord: coordEast(50) })], PLAN)).toHaveLength(1)
  })

  it('a circle stays a circle — the ring the twins drew could never round-trip', () => {
    const a = projectOnto(drawn({ id: 'c1', kind: 'circle', coords: [coordEast(50)], radiusM: 25 }), PLAN)!
    expect(a.kind).toBe('circle')
    expect(a.radiusN).toBeCloseTo(0.25, 4)
  })

  it('a Fläche whose vertices are all just off the paper still meets it', () => {
    const around = drawn({ id: 'a1', kind: 'area', coords: [coordEast(-40), coordEast(140), [mEast(50).lng, ORIGIN.lat - 0.002]] })
    expect(projectOnto(around, PLAN)).not.toBeNull()
  })
})

describe('projection ⇄ bake are inverse', () => {
  const roundTrip = (o: TacticalObject): TacticalObject => {
    const anno = projectOnto(o, PLAN)!
    return bakeGeoBody({ id: o.id, sheet: { planId: 'modul2', anno } }, PLAN, 'taktisch')
  }

  it('a symbol comes back where it stood, pointing where it pointed', () => {
    const o = geo(ent({ id: 'e1', symbol: 'VKF Fahrzeug', coord: coordEast(50), rotation: 30, label: 'Brandherd', count: 2 }))
    const back = roundTrip(o).entity!
    expect(back.coord[0]).toBeCloseTo(o.entity!.coord[0], 8)
    expect(back.rotation).toBeCloseTo(30, 6)
    expect(back).toMatchObject({ label: 'Brandherd', count: 2, symbol: 'VKF Fahrzeug' })
  })

  it('…a Form keeps its metres, a Hubretter its reach, a Trupp its breadcrumbs', () => {
    const shape = roundTrip(geo(ent({ id: 'sh', kind: 'shape', shape: 'square', coord: coordEast(50), sizeM: 30 }))).entity!
    expect(shape.sizeM).toBeCloseTo(30, 3)
    const reach = roundTrip(geo(ent({ id: 'hr', symbol: 'Feuer', coord: coordEast(50), reachM: 18 }))).entity!
    expect(reach.reachM).toBeCloseTo(18, 3)
    const team = roundTrip(geo(ent({ id: 'tm', kind: 'team', coord: coordEast(50), label: 'Trupp 1', t: '10:15', trail: [{ coord: coordEast(20), t: '10:00' }] }))).entity!
    expect(team.trail).toHaveLength(1)
    expect(team.trail![0].coord[0]).toBeCloseTo(mEast(20).lng, 8)
  })

  it('…and a line every vertex, its FKS annotations with it', () => {
    const o = drawn({ id: 'l1', kind: 'line', coords: [coordEast(10), coordEast(60)], lineNo: 2, content: 'S', teilstueck: true })
    const back = roundTrip(o).drawing!
    expect(back.coords[1][0]).toBeCloseTo(mEast(60).lng, 8)
    expect(back).toMatchObject({ lineNo: 2, content: 'S', teilstueck: true })
  })

  it('⚠️ a turned sheet turns the glyph on the paper, and only on the paper', () => {
    // the fit's own turn is a FRAME change: paper-relative in the anno, north-relative on the
    // ground. Applied on one side and not undone on the other, a flip would spin the symbol.
    const turned: PlanFit = {
      fit: fitSimilarity([{ plan: { x: 0, y: 0 }, lngLat: ORIGIN }, { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN.lng, lat: ORIGIN.lat - 0.0009 } }], 1)!,
      aspect: 1,
    }
    const o = geo(ent({ id: 'e1', symbol: 'VKF Fahrzeug', coord: coordEast(0), rotation: 0 }))
    const anno = projectOnto(o, turned)!
    expect(anno.rotation).not.toBe(0) // …turned into the paper's frame
    // …and back to north, where «points north» is said the shorter way: absent
    expect(bakeGeoBody({ id: 'e1', sheet: { planId: 'm', anno } }, turned, 'taktisch').entity!.rotation).toBeUndefined()
    const turnedOnPaper = { ...anno, rotation: (anno.rotation ?? 0) + 30 }
    expect(bakeGeoBody({ id: 'e1', sheet: { planId: 'm', anno: turnedOnPaper } }, turned, 'taktisch').entity!.rotation).toBeCloseTo(30, 6)
  })

  it('…but a symbol with no direction never acquires one from the paper it lies on', () => {
    const o = geo(ent({ id: 'e1', symbol: 'Feuer', coord: coordEast(50) })) // no rotation control
    expect(projectOnto(o, PLAN)!.rotation).toBeUndefined()
  })
})

describe('applyBoardToObjects — a sheet edit of what it was only SHOWING', () => {
  const store = () => [geo(ent({ id: 'e1', symbol: 'Feuer', coord: coordEast(50), label: 'Brandherd' }))]
  const sheet = (o: TacticalObject[]) => projectedAnnos(o, PLAN)

  it('handing the projection straight back changes nothing at all', () => {
    const objects = store()
    expect(applyBoardToObjects(objects, 'modul2', sheet(objects), PLAN, 'taktisch')).toBe(objects)
  })

  it('a prop edit lands on the MAP body and the object stays geo-anchored', () => {
    const objects = store()
    const [a] = sheet(objects)
    const next = applyBoardToObjects(objects, 'modul2', [{ ...a, label: 'Rauch', color: '#f00' }], PLAN, 'taktisch')
    expect(next[0].sheet).toBeUndefined()
    expect(next[0].entity).toMatchObject({ label: 'Rauch', color: '#f00' })
    expect(next[0].entity!.coord).toEqual(objects[0].entity!.coord) // …and exactly where it stood
  })

  it('a MOVE on the sheet flips the anchor, and the bake follows the paper', () => {
    const objects = store()
    const [a] = sheet(objects)
    const next = applyBoardToObjects(objects, 'modul2', [{ ...a, x: 0.25, y: 0.5 }], PLAN, 'taktisch')
    expect(next[0].sheet?.planId).toBe('modul2')
    const baked = bakeGeoBody(next[0], PLAN, 'taktisch')
    expect(baked.entity!.coord[0]).toBeCloseTo(mEast(25).lng, 6) // the map position moved with it
  })

  it('…while a MACHINE move writes through and leaves the anchor alone', () => {
    const objects = store()
    const [a] = sheet(objects)
    const next = applyBoardToObjects(objects, 'modul2', [{ ...a, x: 0.25, y: 0 }], PLAN, 'taktisch', false)
    expect(next[0].sheet).toBeUndefined()
    expect(next[0].entity!.coord[0]).toBeCloseTo(mEast(25).lng, 6)
  })

  it('deleting it on the sheet deletes the object — it is the object', () => {
    expect(applyBoardToObjects(store(), 'modul2', [], PLAN, 'taktisch')).toEqual([])
  })

  it('an object the sheet never showed is untouched by anything that happens on it', () => {
    const objects = [...store(), geo(ent({ id: 'far', coord: coordEast(3000) }))]
    const next = applyBoardToObjects(objects, 'modul2', [], PLAN, 'taktisch')
    expect(next.map((o) => o.id)).toEqual(['far'])
  })

  it('the sheet’s own annos keep their paint order; a shown object keeps its place in the store', () => {
    const objects = [geo(ent({ id: 'e1', coord: coordEast(50) })), { id: 'n1', sheet: { planId: 'modul2', anno: { id: 'n1', kind: 'symbol' as const, x: 0.1, y: 0.1 } } }]
    const annos = [...sheet(objects), objects[1].sheet!.anno]
    const next = applyBoardToObjects(objects, 'modul2', [annos[1], annos[0]], PLAN, 'taktisch')
    // e1 stayed geo-anchored at its index; the native anno is still the only thing on the sheet
    expect(viewsOf(next).board.modul2?.map((a) => a.id)).toEqual(['n1'])
    expect(next[0].id).toBe('e1')
  })
})

describe('inverse in the details, not just in the geometry', () => {
  const TURNED: PlanFit = {
    fit: fitSimilarity([{ plan: { x: 0, y: 0 }, lngLat: ORIGIN }, { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN.lng, lat: ORIGIN.lat - 0.0009 } }], 1)!,
    aspect: 1,
  }
  const roundTrip = (o: TacticalObject, plan = PLAN): TacticalObject =>
    bakeGeoBody({ id: o.id, sheet: { planId: 'm', anno: projectOnto(o, plan)! } }, plan, 'taktisch')

  it('an UNSIZED Form comes back the size it was drawn at', () => {
    // ⚠️ a flat default here meant an unsized Pfeil visibly resized the moment it was flipped
    const arrow = geo(ent({ id: 'a1', kind: 'shape', shape: 'arrow', coord: coordEast(50) }))
    const back = roundTrip(arrow).entity!
    expect(back.sizeM).toBeCloseTo(SHAPE_DEFS.arrow.defaultSizeM, 3)
    expect(back.rotation).toBeUndefined() // …and it did not acquire a bearing on the way
  })

  it('a SECOND bearing turns with the paper too — the boom stays on its truck', () => {
    const mid = TURNED.fit.toMap({ x: 0.5, y: 0.5 })
    const hubretter = geo(ent({ id: 'h1', symbol: 'VKF Hubretter', coord: [mid.lng, mid.lat], rotation: 10, rotation2: 80 }))
    const anno = projectOnto(hubretter, TURNED)!
    expect(anno.rotation2).not.toBe(80) // …expressed in the paper's frame
    const back = bakeGeoBody({ id: 'h1', sheet: { planId: 'm', anno } }, TURNED, 'taktisch').entity!
    expect(back.rotation).toBeCloseTo(10, 6)
    expect(back.rotation2).toBeCloseTo(80, 6)
  })

  it('absent stays absent — nothing materializes as 0 or an empty string', () => {
    // ⚠️ a ROTATABLE glyph, because that is the case the frame change touches: an ordinary
    // unturned Fahrzeug used to come back carrying `rotation: 0` the first time it was flipped
    const bare = geo(ent({ id: 'b1', symbol: 'VKF Fahrzeug', coord: coordEast(50) }))
    const back = roundTrip(bare).entity!
    expect(back.rotation).toBeUndefined()
    expect(back.rotation2).toBeUndefined()
    expect(back.label).toBeUndefined()
    const note = roundTrip(geo(ent({ id: 'n1', kind: 'note', coord: coordEast(50) }))).entity!
    expect(note.label).toBeUndefined()
  })
})
