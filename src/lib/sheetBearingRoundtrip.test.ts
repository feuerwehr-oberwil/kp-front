import { describe, expect, it } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import { bearing360, turnedToGround, turnedToSheet } from './planProjection'
import {
  applyBoardToObjects, applyDocToObjects, bakeAll, bakePlan, sheetAnnos, viewsOf,
  type PlanFit, type TacticalObject,
} from './tacticalObjects'
import { stackGroundFit } from './stackFit'
import { floorPackOf } from './floorPackBinding'
import { buildingPackBinding } from './buildingPackBinding'
import { tileAspectOf } from './whiteboard'
import { sanitizeWorkspace } from './workspace'
import type { IncidentPlanBinding } from './incidentPlanBindings'
import type { BoardAnno, BuildingDoc, Drawing, Entity } from '../types'

/* A sheet's bearings across the DOC seam (24.09.2026, Feueralarm-Übung 23.09., post-mortem A2).
 *
 * The bake turns a stored paper bearing into a ground one (`turnedToGround`); the Karte's write
 * seam used to hand the ground bearing straight back as if it were the paper's, for every
 * sheet-anchored object in every write — so each «Karte write → bake» cycle turned the glyph by
 * the sheet's own −rotationDeg. The live-GPS loop ran that cycle continuously on the Gebäude stack
 * (rotationDeg −41.49), and one Lüfter reached 66 735°. These tests pin the inverse: in geometry,
 * in absence, per object, over many cycles, and on the real data. */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: mEast(100) },
]
const BASE = fitSimilarity(PAIRS, 1)!
/** the sheet's own turn — only `rotationDeg` takes part in the bearing conversion */
const turned = (rotationDeg: number): PlanFit => ({ fit: { ...BASE, rotationDeg }, aspect: 1 })
const PROD_TURN = -41.490822548742656

const LUEFTER = 'VKF Luefter mobil'   // directional, one bearing
const HUBRETTER = 'VKF Hubretter'     // directional, and a second bearing (the boom)
const FEUER = 'VKF Feuer'             // no direction at all

const sym = (id: string, over: Partial<BoardAnno> = {}): BoardAnno => ({ id, kind: 'symbol', x: 0.5, y: 0.5, ...over })
const onSheet = (anno: BoardAnno, planId = 'modul2'): TacticalObject => ({ id: anno.id, sheet: { planId, anno } })

/** deterministic, so a failure names the pair that drifted */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
/** the three heavy tests run alone in about a second; the full suite runs ~330 files in
 *  parallel beside them, so they get room beyond vitest's 5 s default */
const HEAVY_MS = 60_000

/** A Karte write exactly as the renderer hands it back: the whole document, fresh identities,
 *  with an optional patch on ONE object and an optional machine-moved line that is nobody's. */
function karteWrite(
  objects: TacticalObject[], fits: ReadonlyMap<string, PlanFit>,
  opts: { patch?: { id: string; with: Partial<Entity> }; gpsLine?: number } = {},
): TacticalObject[] {
  const view = viewsOf(objects)
  const entities = clone(view.entities).map((e) => (opts.patch?.id === e.id ? { ...e, ...opts.patch.with } : e))
  const drawings: Drawing[] = clone(view.drawings).filter((d) => d.id !== 'gps-line')
  if (opts.gpsLine != null) {
    drawings.push({ id: 'gps-line', kind: 'line', coords: [[ORIGIN.lng, ORIGIN.lat], [ORIGIN.lng + opts.gpsLine * 1e-7, ORIGIN.lat + 1e-4]] })
  }
  return applyDocToObjects(objects, { entities, drawings }, fits, opts.gpsLine == null)
}

const sheetOf = (objects: TacticalObject[], id: string) => objects.find((o) => o.id === id)!.sheet!.anno
const groundOf = (objects: TacticalObject[], id: string) => objects.find((o) => o.id === id)!.entity!
/** equal on the circle, to within `eps` */
const sameBearing = (a: number | undefined, b: number | undefined, eps = 1e-9) => {
  if (a == null || b == null) return a == null && b == null
  const d = Math.abs(bearing360(a) - bearing360(b))
  return Math.min(d, 360 - d) < eps
}

describe('the frame change answers in [0, 360), both ways', () => {
  it('never hands out a bearing a human cannot read', () => {
    const { fit } = turned(PROD_TURN)
    expect(turnedToSheet(10, fit, true)).toBeCloseTo(328.509177451257, 9)
    expect(turnedToGround(350, fit, true)).toBeCloseTo(31.490822548742656, 9)
    expect(turnedToSheet(undefined, fit, true)).toBeCloseTo(318.509177451257, 9)
    // (360 + R) − R lands a hair off 360: that hair is north, and north is ABSENT
    expect(turnedToGround(turnedToSheet(undefined, fit, true), fit, true)).toBeUndefined()
    expect(turnedToSheet(66735.29772321768, turned(0).fit, true)).toBeCloseTo(135.29772321768, 6)
    // a glyph with no direction is not a bearing at all, and is handed through untouched
    expect(turnedToSheet(400, fit, false)).toBe(400)
    expect(turnedToGround(-5, fit, false)).toBe(-5)
  })
})

describe('bearings across the doc seam, on a turned sheet', () => {
  const TURNS = [PROD_TURN, 17.25, -133.7, 179.99, 0]

  for (const R of TURNS) {
    const plan = turned(R)
    const fits = new Map([['modul2', plan]])
    const seed = (): TacticalObject[] => bakeAll([
      onSheet(sym('L', { symbol: LUEFTER, rotation: 177 })),
      onSheet(sym('H', { symbol: HUBRETTER, rotation: 240, rotation2: 267 })),
      onSheet(sym('F', { symbol: FEUER })),
      onSheet({ id: 'S', kind: 'shape', shape: 'arrow', x: 0.4, y: 0.4, sizeN: 0.1, rotation: 133 }),
    ], fits, 'taktisch')

    describe(`rotationDeg ${R}`, () => {
      it('(a) bake ∘ unchanged Karte write is the identity — record for record', () => {
        const before = seed()
        const written = karteWrite(before, fits)
        for (const o of before) expect(written.find((x) => x.id === o.id)).toBe(o)
        expect(bakeAll(written, fits, 'taktisch')).toBe(written)
        // …and a machine write that moves only somebody else's line is no different
        const polled = karteWrite(before, fits, { gpsLine: 1 })
        for (const o of before) expect(polled.find((x) => x.id === o.id)).toBe(o)
      })

      it('(a) a re-style on the Karte writes through WITHOUT turning the paper bearing', () => {
        let objects = seed()
        const paper = { L: sheetOf(objects, 'L').rotation, H: [sheetOf(objects, 'H').rotation, sheetOf(objects, 'H').rotation2], S: sheetOf(objects, 'S').rotation }
        for (let i = 0; i < 5; i++) {
          objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'L', with: { label: `Lüfter ${i}` } } }), fits, 'taktisch')
          objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'H', with: { count: i + 2 } } }), fits, 'taktisch')
          objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'S', with: { color: i % 2 ? '#f00' : '#00f' } } }), fits, 'taktisch')
        }
        expect(sheetOf(objects, 'L')).toMatchObject({ label: 'Lüfter 4', rotation: paper.L })
        expect(sheetOf(objects, 'H')).toMatchObject({ count: 6, rotation: paper.H[0], rotation2: paper.H[1] })
        expect(sheetOf(objects, 'S').rotation).toBe(paper.S)
      })

      it('(b) a bearing set on the Karte reaches the paper and comes back exactly', () => {
        for (const g of [0.5, 90, 181.25, 359.9, 12.345678]) {
          let objects = seed()
          objects = karteWrite(objects, fits, { patch: { id: 'H', with: { rotation: g, rotation2: g / 2 } } })
          expect(sameBearing(sheetOf(objects, 'H').rotation, g + R)).toBe(true)
          objects = bakeAll(objects, fits, 'taktisch')
          expect(sameBearing(groundOf(objects, 'H').rotation, g)).toBe(true)
          expect(sameBearing(groundOf(objects, 'H').rotation2, g / 2)).toBe(true)
          // …and it has settled: the next unchanged write and bake change nothing
          const again = bakeAll(karteWrite(objects, fits), fits, 'taktisch')
          expect(again.find((o) => o.id === 'H')).toBe(objects.find((o) => o.id === 'H'))
        }
      })

      it('(c) a bearing set on the sheet reaches the Karte and comes back exactly', () => {
        for (const s of [0, 45, 200.5, 359]) {
          let objects = seed()
          const annos = sheetAnnos(objects, 'modul2', plan).map((a) => (a.id === 'L' ? { ...a, rotation: s } : a))
          objects = bakePlan(applyBoardToObjects(objects, 'modul2', annos, plan, 'taktisch', true, fits), 'modul2', plan, 'taktisch')
          expect(sameBearing(groundOf(objects, 'L').rotation ?? 0, s - R)).toBe(true)
          for (let i = 0; i < 3; i++) objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'L', with: { notes: `n${i}` } } }), fits, 'taktisch')
          expect(sheetOf(objects, 'L').rotation).toBe(s)
        }
      })

      it('(d) an absent bearing stays absent, both ways', () => {
        // sheet → ground → sheet: nothing on the paper, nothing invented on the way back
        let objects = seed()
        expect(sheetOf(objects, 'F').rotation).toBeUndefined()
        expect(groundOf(objects, 'F').rotation).toBeUndefined() // no direction, no paper turn
        expect(sheetOf(objects, 'L').rotation2).toBeUndefined()
        objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'F', with: { label: 'Brand' } } }), fits, 'taktisch')
        objects = bakeAll(karteWrite(objects, fits, { patch: { id: 'L', with: { label: 'Lüfter' } } }), fits, 'taktisch')
        expect(sheetOf(objects, 'F').rotation).toBeUndefined()
        expect(sheetOf(objects, 'L').rotation2).toBeUndefined()
        // a directional glyph with NO paper bearing: the bake says the paper's turn, the write-back
        // keeps the anno absent
        const bare = bakeAll([onSheet(sym('B', { symbol: LUEFTER }))], fits, 'taktisch')
        expect(groundOf(bare, 'B').rotation).toBe(R === 0 ? undefined : bearing360(-R))
        const back = bakeAll(karteWrite(bare, fits, { patch: { id: 'B', with: { label: 'x' } } }), fits, 'taktisch')
        expect(sheetOf(back, 'B').rotation).toBeUndefined()
        // ground → sheet → ground: a bearing CLEARED on the Karte is absent on the ground again,
        // and on an unturned sheet the paper does not acquire a `0` either
        let cleared = karteWrite(seed(), fits, { patch: { id: 'H', with: { rotation: undefined, rotation2: undefined } } })
        expect(sheetOf(cleared, 'H').rotation2).toBeUndefined()
        expect(sheetOf(cleared, 'H').rotation).toBe(R === 0 ? undefined : bearing360(R))
        cleared = bakeAll(cleared, fits, 'taktisch')
        expect(groundOf(cleared, 'H').rotation).toBeUndefined()
        expect(groundOf(cleared, 'H').rotation2).toBeUndefined()
      })

      it('(e) turning one object never turns another', () => {
        const before = seed()
        // on the Karte…
        const karte = bakeAll(karteWrite(before, fits, { patch: { id: 'L', with: { rotation: 10 } } }), fits, 'taktisch')
        for (const id of ['H', 'F', 'S']) expect(karte.find((o) => o.id === id)).toBe(before.find((o) => o.id === id))
        // …and on the sheet, through the plan's whole re-bake and the next GPS poll
        const annos = sheetAnnos(before, 'modul2', plan).map((a) => (a.id === 'L' ? { ...a, rotation: 300 } : a))
        let sheet = bakePlan(applyBoardToObjects(before, 'modul2', annos, plan, 'taktisch', true, fits), 'modul2', plan, 'taktisch')
        sheet = bakeAll(karteWrite(sheet, fits, { gpsLine: 2 }), fits, 'taktisch')
        // (the plan seam re-seats its own records, so this half is by value, not by identity)
        for (const id of ['H', 'F', 'S']) {
          const was = before.find((o) => o.id === id)!, now = sheet.find((o) => o.id === id)!
          expect(now.sheet).toEqual(was.sheet)
          expect(now.entity).toEqual(was.entity)
        }
      })
    })
  }

  it('without a fit the paper keeps its own bearing — there is nothing to convert through', () => {
    const fits = new Map([['modul2', turned(PROD_TURN)]])
    const baked = bakeAll([onSheet(sym('L', { symbol: LUEFTER, rotation: 177 }))], fits, 'taktisch')
    // the reference is gone; the Karte still carries the last baked body and turns it
    const next = karteWrite(baked, new Map(), { patch: { id: 'L', with: { rotation: 5 } } })
    expect(sheetOf(next, 'L').rotation).toBe(177)
    expect(groundOf(next, 'L').rotation).toBe(5)
  })
})

describe('property: 1 000 random (sheet turn, bearing) pairs × 50 write/bake cycles', () => {
  it('drifts by exactly nothing', () => {
    const rnd = prng(0x23092026)
    let checked = 0
    for (let n = 0; n < 1000; n++) {
      const R = (rnd() - 0.5) * 720 // beyond ±360 on purpose: a fit's turn is not normalised
      const rot = rnd() * 360
      const rot2 = rnd() < 0.5 ? rnd() * 360 : undefined
      const fits = new Map([['m', turned(R)]])
      let objects = bakeAll([
        onSheet(sym('A', { symbol: rot2 == null ? LUEFTER : HUBRETTER, rotation: rot, rotation2: rot2 }), 'm'),
        onSheet({ id: 'S', kind: 'shape', shape: 'arrow', x: 0.3, y: 0.6, sizeN: 0.1, rotation: rot }, 'm'),
      ], fits, 'taktisch')
      const paper = [sheetOf(objects, 'A').rotation, sheetOf(objects, 'A').rotation2, sheetOf(objects, 'S').rotation]
      const ground = [groundOf(objects, 'A').rotation, groundOf(objects, 'A').rotation2, groundOf(objects, 'S').rotation]
      for (let c = 0; c < 50; c++) {
        // a prop edit on each, so the write really crosses the conversion rather than the identity
        objects = karteWrite(objects, fits, { patch: { id: c % 2 ? 'A' : 'S', with: { color: `#${(c % 10).toString().repeat(6)}` } }, gpsLine: c })
        objects = bakeAll(objects, fits, 'taktisch')
      }
      expect([sheetOf(objects, 'A').rotation, sheetOf(objects, 'A').rotation2, sheetOf(objects, 'S').rotation]).toEqual(paper)
      expect([groundOf(objects, 'A').rotation, groundOf(objects, 'A').rotation2, groundOf(objects, 'S').rotation]).toEqual(ground)
      for (const g of ground) if (g != null) expect(g >= 0 && g < 360).toBe(true)
      checked++
    }
    expect(checked).toBe(1000)
  }, HEAVY_MS)
})

/* ── the real thing ─────────────────────────────────────────────────────────────────────────────
 * Trimmed from the production workspace of the Feueralarm-Übung 23.09.2026 (incident 717273eb…,
 * final revision 574): the Gebäude stack, its Modul-6 binding and the four Lüfter exactly as they
 * were stored — anno and baked body alike carrying the ground bearing the doc seam wrote into the
 * paper. Only the fields the stack fit and the bearings need; nothing personal. */

const PROD_BUILDING = {
  pack: { frame: [0.49368767995573737, 0.2704554156312634, 0.9695728408918157, 0.516764444367985], aspect: 0.7062613364430503, bindingId: 'object:19e07674-3cbb-514a-81ed-4645b42340df:plan:modul6' },
  ring: [], rings: [], floors: [-1, 0, 1, 2, 3, 4], tileAR: 0.804343198933631, ringAspect: 0.732846025695086,
} as unknown as BuildingDoc

const floorRow = (index: number, clip: number[], join: { at: number[]; to: number; there: number[] } | null) =>
  ({ clip, join, name: null, page: 0, part: 0, index })
const THERE = [0.6750850386801757, 0.4009248765989806]
const PROD_MODUL6 = {
  id: 'object:19e07674-3cbb-514a-81ed-4645b42340df:plan:modul6', page: 0, aspect: 0.7062613364430503, planId: 'modul6',
  source: 'approved', objectId: '19e07674-3cbb-514a-81ed-4645b42340df', datasetId: 'plan:19e07674-3cbb-514a-81ed-4645b42340df:modul6', planVersion: 12,
  floors: [
    floorRow(-1, [0.502869958040504, 0.5923033762977676, 0.8265696642247142, 0.7565016641716635], { at: [0.6750847124517826, 0.6557567626462044], to: 0, there: THERE }),
    floorRow(0, [0.4979748828785697, 0.2704554156312634, 0.9601931040102386, 0.5162442979221074], null),
    floorRow(1, [0.4979747378881728, 0.028512770289013778, 0.9595022972640964, 0.2658584249336876], { at: [0.6750830813098172, 0.15001885716468322], to: 0, there: THERE }),
    floorRow(2, [0.02473914958927483, 0.5300101817425167, 0.4977231976733101, 0.7532682466748567], { at: [0.20526944761631075, 0.6552836183105066], to: 0, there: THERE }),
    floorRow(3, [0.02473914958927483, 0.27467495583184054, 0.4977231976733101, 0.5026629921051815], { at: [0.2061365083137131, 0.4022209162667135], to: 0, there: THERE }),
    floorRow(4, [0.04433869771220378, 0.03040862446737347, 0.500662914218534, 0.2566266575283914], { at: [0.206175112006894, 0.15505207659726017], to: 0, there: THERE }),
  ],
  georef: { pairs: [
    { kind: 'gesetzt', plan: { x: 0.527069761477023, y: 0.44118223516845345 }, lngLat: { lat: 47.5232878829, lng: 7.54911309483 } },
    { kind: 'gesetzt', plan: { x: 0.9302073862892876, y: 0.4948069836329232 }, lngLat: { lat: 47.5225014819, lng: 7.55000856369 } },
    { kind: 'gesetzt', plan: { x: 0.9210204685118193, y: 0.28469106455069104 }, lngLat: { lat: 47.5230588291, lng: 7.55067465351 } },
  ] },
} as unknown as IncidentPlanBinding

/** one Lüfter as the blob stored it: anno and baked body both at the drifted value */
const prodLuefter = (id: string, x: number, y: number, coord: [number, number], typ: string, rotation: number) => {
  const shared = { label: 'Lüfter', fields: { Typ: typ, Bedienung: '' }, symbol: LUEFTER, floorFrom: 0, floorTo: 0, rotation, subtitle: 'Fahrzeuge / Mittel' }
  return {
    id,
    sheet: { planId: 'gebaeude', anno: { id, kind: 'symbol', x, y, floor: 0, ...shared } },
    entity: { id, kind: 'symbol', layer: 'taktisch', coord, ...shared },
  }
}
const PROD_LUEFTER = [
  prodLuefter('s1790185500103', 0.748143072674709, 0.7108388139508888, [7.549951819792105, 47.52271036707812], 'Überdruck', 218.4908225488246),
  prodLuefter('s1790185524129', 0.6033605150139417, 0.61443087508255, [7.5498444588978115, 47.52290598534249], 'Überdruck', 66735.29772321768),
  prodLuefter('s1790188805993', 0.8697965212214189, 0.6304721777636493, [7.55020377829615, 47.522669498833245], 'Elektro', 281.4908225488246),
  prodLuefter('s1790188858204', 0.6566911677562919, 0.30309066578505206, [7.550231663886022, 47.52309937656341], 'Akku', 3931.1923842965716),
]

function gebaeudeFit(): PlanFit {
  const pack = floorPackOf([buildingPackBinding(PROD_BUILDING, [PROD_MODUL6])!], PROD_MODUL6.objectId)!
  const fit = stackGroundFit(PROD_BUILDING, pack.fit)!
  return { fit, aspect: 1 / tileAspectOf(PROD_BUILDING), stack: { floors: PROD_BUILDING.floors } }
}

describe('regression: the four Lüfter of the Feueralarm-Übung 23.09.2026', () => {
  const plan = gebaeudeFit()
  const fits = new Map([['gebaeude', plan]])

  it('the stack fit is the turned sheet the field ran on', () => {
    expect(plan.fit.rotationDeg).toBeCloseTo(PROD_TURN, 6)
  })

  it('the corrupted stored bearings load as their mod-360 values — and nothing is counted lost', () => {
    const gate = sanitizeWorkspace({ schemaVersion: 2, objects: clone(PROD_LUEFTER) })
    expect(gate.dropped).toBe(0)
    const objects = gate.ws!.objects!
    for (const stored of PROD_LUEFTER) {
      const o = objects.find((x) => x.id === stored.id)!
      const want = stored.sheet.anno.rotation % 360
      expect(o.sheet!.anno.rotation).toBeCloseTo(want, 9)
      expect(o.entity!.rotation).toBeCloseTo(want, 9)
    }
    // mod only — the 66 735.30° Lüfter is 135.30°, not the 267° somebody once meant
    expect(objects.find((o) => o.id === 's1790185524129')!.sheet!.anno.rotation).toBeCloseTo(135.29772321768, 6)
    expect(objects.find((o) => o.id === 's1790188858204')!.sheet!.anno.rotation).toBeCloseTo(331.1923842965716, 6)
  })

  it('1 000 GPS polls, re-styles and re-bakes later, not one of them has turned', () => {
    let objects = bakeAll(sanitizeWorkspace({ schemaVersion: 2, objects: clone(PROD_LUEFTER) }).ws!.objects!, fits, 'taktisch')
    const luefter = (os: TacticalObject[]) => PROD_LUEFTER.map(({ id }) => os.find((o) => o.id === id)!)
    const paper = luefter(objects).map((o) => o.sheet!.anno.rotation)
    const ground = luefter(objects).map((o) => o.entity!.rotation)
    for (const g of ground) expect(g! >= 0 && g! < 360).toBe(true)
    for (let i = 0; i < 1000; i++) {
      objects = karteWrite(objects, fits, { gpsLine: i }) // the live-GPS pass: a machine write of nobody's line
      if (i % 10 === 0) objects = karteWrite(objects, fits, { patch: { id: PROD_LUEFTER[i % 4].id, with: { notes: `Runde ${i}` } } })
      objects = bakePlan(objects, 'gebaeude', plan, 'taktisch')
    }
    expect(luefter(objects).map((o) => o.sheet!.anno.rotation)).toEqual(paper)
    expect(luefter(objects).map((o) => o.entity!.rotation)).toEqual(ground)
  }, HEAVY_MS)

  it('turning ONE Lüfter on the Gebäude leaves the other three where they are', () => {
    let objects = bakeAll(sanitizeWorkspace({ schemaVersion: 2, objects: clone(PROD_LUEFTER) }).ws!.objects!, fits, 'taktisch')
    objects = karteWrite(objects, fits, { gpsLine: 1 })
    const others = objects.filter((o) => o.sheet && o.id !== 's1790185500103')
    // the rotate handle's samples (Whiteboard · patch → setBoard → applyBoardToObjects + bakePlan), each followed by a GPS poll
    for (const deg of [180, 190, 200]) {
      const annos = sheetAnnos(objects, 'gebaeude', plan).map((a) => (a.id === 's1790185500103' ? { ...a, rotation: deg } : a))
      objects = bakePlan(applyBoardToObjects(objects, 'gebaeude', annos, plan, 'taktisch', true, fits), 'gebaeude', plan, 'taktisch')
      objects = karteWrite(objects, fits, { gpsLine: deg })
    }
    expect(sheetOf(objects, 's1790185500103').rotation).toBe(200)
    for (const o of others) {
      const now = objects.find((x) => x.id === o.id)!
      expect(now.sheet).toEqual(o.sheet)
      expect(now.entity).toEqual(o.entity)
    }
  })
})

describe('load: 2 000 sheet-anchored objects × 20 bake + Karte-write cycles', () => {
  it('settles after the first cycle and stays inside a generous ceiling', () => {
    const rnd = prng(2000)
    const fits = new Map<string, PlanFit>([['m1', turned(PROD_TURN)], ['m2', turned(73.2)], ['m3', turned(-160.05)]])
    const plans = ['m1', 'm2', 'm3']
    const seedObjects: TacticalObject[] = []
    for (let i = 0; i < 2000; i++) {
      const id = `o${i}`, planId = plans[i % 3], x = 0.05 + rnd() * 0.9, y = 0.05 + rnd() * 0.9
      const k = i % 6
      const anno: BoardAnno =
        k === 0 ? sym(id, { symbol: LUEFTER, x, y, rotation: rnd() * 360 })
        : k === 1 ? sym(id, { symbol: HUBRETTER, x, y, rotation: rnd() * 360, rotation2: rnd() * 360, reachN: 0.1 })
        : k === 2 ? sym(id, { symbol: FEUER, x, y })
        : k === 3 ? { id, kind: 'shape', shape: 'arrow', x, y, sizeN: 0.05, rotation: rnd() * 360 }
        : k === 4 ? { id, kind: 'text', x, y, text: `Notiz ${i}` }
        : { id, kind: 'draw', pts: [[x, y], [Math.min(1, x + 0.05), y]], color: '#e00' }
      seedObjects.push(onSheet(anno, planId))
    }
    const t0 = performance.now()
    let objects = bakeAll(seedObjects, fits, 'taktisch')
    let changedAfterFirst = 0
    for (let c = 0; c < 20; c++) {
      const before = objects
      objects = bakeAll(karteWrite(objects, fits, { gpsLine: c }), fits, 'taktisch')
      if (c > 0) {
        const now = new Map(objects.map((o) => [o.id, o]))
        for (const o of before) if (o.sheet && now.get(o.id) !== o) changedAfterFirst++
      }
    }
    const ms = performance.now() - t0
    expect(changedAfterFirst).toBe(0)
    expect(objects.filter((o) => o.sheet)).toHaveLength(2000)
    expect(ms).toBeLessThan(20_000)
  }, HEAVY_MS)
})
