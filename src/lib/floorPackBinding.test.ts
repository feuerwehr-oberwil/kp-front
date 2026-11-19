import { describe, expect, it } from 'vitest'
import { barStorey, floorPackOf, frameAspect, joinShifts, packFloorNames, packStoreys, sheetDrawings, sheetFloorsOf, trimmedPackFrame, withDrawingStorey } from './floorPackBinding'
import type { BoardAnno } from '../types'
import { inheritPlanBinding } from './incidentPlanBindings'
import type { GeorefPair } from './georef'

const pairs: GeorefPair[] = [
  { plan: { x: 0.1, y: 0.8 }, lngLat: { lng: 7.555, lat: 47.511 }, kind: 'gesetzt' },
  { plan: { x: 0.9, y: 0.8 }, lngLat: { lng: 7.556, lat: 47.5117 }, kind: 'gesetzt' },
]
const sheet = { id: 'object:wyss:plan:modul6', objectId: 'wyss', planId: 'modul6', datasetId: 'plan:wyss:modul6', planVersion: 2, title: 'Modul 6' }
const approval = { id: 1, pairs, aspect: 1.414, approved_at: '2026-09-14' }

describe('a floor pack as the stack sees it', () => {
  it('one floor per page: whole pages, no shift, the fit page\'s floor 0 is the frame', () => {
    const floors = [{ page: 0, index: 1, name: null }, { page: 1, index: 0, name: 'EG' }, { page: 2, index: -1, name: null }]
    const b = { ...inheritPlanBinding(sheet, approval, null, false, floors), page: 1 }
    const pack = floorPackOf([b], 'wyss')!
    expect(pack.frame).toEqual([0, 0, 1, 1])
    expect(pack.tiles[1][0]).toMatchObject({ url: '/api/reference/plan%3Awyss%3Amodul6?v=2#page=1', clip: [0, 0, 1, 1], shift: [0, 0] })
    expect(pack.fit).toBeTruthy()
    expect(floorPackOf([b], 'other')).toBeNull()
  })
  it('regions of one A0: the reference clip is the frame, siblings shift through their joins', () => {
    const floors = [
      { page: 0, index: 1, name: null, clip: [0.02, 0.5, 0.35, 0.95] as [number, number, number, number], join: { to: 0, at: [0.05, 0.9] as [number, number], there: [0.41, 0.45] as [number, number] } },
      { page: 0, index: 0, name: 'EG', clip: [0.38, 0.02, 0.98, 0.5] as [number, number, number, number] },
    ]
    const pack = floorPackOf([{ ...inheritPlanBinding(sheet, approval, null, false, floors), page: 0 }], 'wyss')!
    expect(pack.frame).toEqual([0.38, 0.02, 0.98, 0.5])
    expect(pack.tiles[0][0].shift).toEqual([0, 0])
    expect(pack.tiles[1][0].shift[0]).toBeCloseTo(0.36); expect(pack.tiles[1][0].shift[1]).toBeCloseTo(-0.45)
    expect(pack.tiles[1][0].clip).toEqual([0.02, 0.5, 0.35, 0.95])
    // a landscape A0 (w/h 1.414) region 0.6 wide × 0.48 tall → box h/w ≈ 0.566
    expect(frameAspect(pack.frame, 1.414)).toBeCloseTo(0.48 / (0.6 * 1.414), 3)
  })
})

describe('joins chain in both directions', () => {
  const sheetB = { ...sheet }
  it('A joins B, C joins B, D is joined FROM C – all four resolve; an island falls back to its corner', () => {
    const c = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0, y0, x1, y1]
    const floors = [
      { page: 0, index: 0, name: null, clip: c(0.5, 0.5, 0.9, 0.9) }, // B, the reference
      { page: 0, index: 1, name: null, clip: c(0.0, 0.5, 0.4, 0.9), join: { to: 0, at: [0.1, 0.6] as [number, number], there: [0.6, 0.6] as [number, number] } }, // A → B
      { page: 0, index: 2, name: null, clip: c(0.0, 0.0, 0.4, 0.4), join: { to: 0, at: [0.1, 0.1] as [number, number], there: [0.6, 0.6] as [number, number] } }, // C → B
      { page: 0, index: 3, name: null, clip: c(0.5, 0.0, 0.9, 0.4) }, // D, joined from C below
      { page: 0, index: -1, name: null, clip: c(0.2, 0.2, 0.3, 0.3) }, // island
    ]
    floors[2] = { ...floors[2], join: floors[2].join } // keep C → B
    const withD = floors.map((f) => f.index === 2 ? f : f)
    // C also says «my 0.1/0.1 is D's 0.6/0.1»? no – D joins from C: add that join on C's side is impossible (one join per floor), so D joins C
    withD[3] = { ...withD[3], join: { to: 2, at: [0.6, 0.1], there: [0.1, 0.1] } }
    const pack = floorPackOf([{ ...inheritPlanBinding(sheetB, approval, null, false, withD), page: 0 }], 'wyss')!
    expect(pack.tiles[1][0].shift.map((v) => +v.toFixed(3))).toEqual([0.5, 0])
    expect(pack.tiles[2][0].shift.map((v) => +v.toFixed(3))).toEqual([0.5, 0.5])
    expect(pack.tiles[3][0].shift.map((v) => +v.toFixed(3))).toEqual([0, 0.5]) // through C
    expect(pack.tiles[-1][0].shift.map((v) => +v.toFixed(3))).toEqual([0.3, 0.3]) // corner fallback: ref x0 − island x0
  })
})


it('resolves joins across pages and within non-reference pages before defaults', () => {
  const ref = { page: 0, index: 0, name: null }
  const shifts = joinShifts([
    ref,
    { page: 1, index: 1, name: null, join: { to: 0, at: [0.2, 0.3], there: [0.6, 0.7] } },
    { page: 1, index: 2, name: null, join: { to: 1, at: [0.1, 0.1], there: [0.2, 0.3] } },
    { page: 2, index: 3, name: null },
    { page: 2, index: 4, name: null, join: { to: 3, at: [0.1, 0.1], there: [0.5, 0.6] } },
  ], ref)
  expect(shifts.get('1:0')?.map(v => +v.toFixed(3))).toEqual([0.4, 0.4])
  expect(shifts.get('2:0')?.map(v => +v.toFixed(3))).toEqual([0.5, 0.6])
  expect(shifts.get('3:0')).toEqual([0, 0])
  expect(shifts.get('4:0')?.map(v => +v.toFixed(3))).toEqual([0.4, 0.5])
})


it('resolves a cross-page join pointing away from the reference', () => {
  const ref = { page: 0, index: 0, name: null, join: { to: 1, at: [0.6, 0.7] as [number, number], there: [0.2, 0.3] as [number, number] } }
  const shifts = joinShifts([ref, { page: 1, index: 1, name: null }], ref)
  expect(shifts.get('1:0')?.map(v => +v.toFixed(3))).toEqual([0.4, 0.4])
})


// One Geschoss out of several drawings (16.09.2026): each wing joins the reference at its own
// staircase, so a storey has SEVERAL tiles and they land beside each other in the one frame.
describe('a storey drawn as two wings', () => {
  const c = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0, y0, x1, y1]
  const floors = [
    { page: 0, index: 0, part: 0, name: 'EG', clip: c(0.05, 0.05, 0.95, 0.45) },
    { page: 0, index: 1, part: 0, name: 'Westflügel', clip: c(0.05, 0.55, 0.45, 0.95), join: { to: 0, at: [0.1, 0.6] as [number, number], there: [0.1, 0.1] as [number, number] } },
    { page: 0, index: 1, part: 1, name: 'Ostflügel', clip: c(0.55, 0.55, 0.95, 0.95), join: { to: 0, at: [0.6, 0.6] as [number, number], there: [0.6, 0.1] as [number, number] } },
  ]
  it('gives each drawing its own shift, keyed by storey AND part', () => {
    const shifts = joinShifts(floors, floors[0])
    expect(shifts.get('0:0')).toEqual([0, 0])
    expect(shifts.get('1:0')!.map((v) => +v.toFixed(3))).toEqual([0, -0.5])
    expect(shifts.get('1:1')!.map((v) => +v.toFixed(3))).toEqual([0, -0.5])
    // …and a join may point at a specific wing: the EG hangs on the OST wing here
    const onEast = [
      { ...floors[0], join: { to: 1, part: 1, at: [0.6, 0.1] as [number, number], there: [0.6, 0.6] as [number, number] } },
      floors[2],
    ]
    expect(joinShifts(onEast, onEast[1]).get('0:0')!.map((v) => +v.toFixed(3))).toEqual([0, 0.5])
  })
  it('lists both drawings under the one storey tile, in part order', () => {
    const pack = floorPackOf([{ ...inheritPlanBinding(sheet, approval, null, false, floors), page: 0 }], 'wyss')!
    expect(pack.frame).toEqual([0.05, 0.05, 0.95, 0.45])
    expect(pack.tiles[0]).toHaveLength(1)
    expect(pack.tiles[1].map((t) => [t.part, t.name])).toEqual([[0, 'Westflügel'], [1, 'Ostflügel']])
    expect(pack.tiles[1][0].clip).toEqual([0.05, 0.55, 0.45, 0.95])
    expect(pack.tiles[1][1].clip).toEqual([0.55, 0.55, 0.95, 0.95])
    // the stack gets ONE tile per Geschoss, and a wing's own name never becomes the storey's
    expect(packStoreys(floors)).toEqual([0, 1])
    expect(packFloorNames(floors)).toEqual({ '0': 'EG' })
  })
})

// The frame is drawn by hand in the admin and carries whatever paper margin was left around the
// drawing – on a shared frame that margin is paid once per storey (Bastian, 16.09.2026).
describe('trimmedPackFrame', () => {
  const tile = (clip: [number, number, number, number], shift: [number, number] = [0, 0]) =>
    ({ url: 'p.pdf#page=1', clip, shift, part: 0, name: null })
  const view = {
    frame: [0.05, 0.05, 0.95, 0.45] as [number, number, number, number],
    tiles: { 0: [tile([0.05, 0.05, 0.95, 0.45])], 1: [tile([0.05, 0.55, 0.45, 0.95], [0, -0.5])] },
  }

  it('trims the frame to where the ink actually stops', async () => {
    // both drawings sit in the middle of their rectangle, the upper storey using less of it
    const ink = async (_u: string, c: [number, number, number, number]) =>
      [c[0] + 0.1, c[1] + 0.05, c[2] - 0.1, c[3] - 0.05] as const
    expect((await trimmedPackFrame(view, ink)).map((v) => +v.toFixed(3)))
      .toEqual([0.15, 0.1, 0.85, 0.4])
  })

  // ⚠️ a wing drawn outside the reference rectangle used to hang off its tile
  it('widens the frame around a drawing that reaches past the reference', async () => {
    const wide = { ...view, tiles: { ...view.tiles, 1: [tile([0.05, 0.55, 0.45, 0.95], [0.6, -0.5])] } }
    const out = await trimmedPackFrame(wide, async (_u, c) => c)
    expect(+out[2].toFixed(3)).toBe(1.05)
  })

  it('falls back to the drawing\'s own rectangle when the ink cannot be measured', async () => {
    expect(await trimmedPackFrame(view, async () => null)).toEqual([0.05, 0.05, 0.95, 0.45])
    expect(await trimmedPackFrame(view, () => Promise.reject(new Error('offline')))).toEqual([0.05, 0.05, 0.95, 0.45])
  })

  it('keeps the frame it was given rather than collapsing onto a speck of ink', async () => {
    const speck = async (_u: string, c: [number, number, number, number]) => [c[0], c[1], c[0] + 0.001, c[1] + 0.001] as const
    expect(await trimmedPackFrame(view, speck)).toEqual(view.frame)
  })
})

// owner, 18.11.2026: «on georeferenced module 6 also auto-change storeys like in gebäude» – a sheet
// with its storeys drawn side by side (the shot: 3OG · EG over 2OG · 1UG on one page)
describe('a plain sheet that shows a floor pack', () => {
  const c = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0, y0, x1, y1]
  const floors = [
    { page: 0, index: 3, name: '3OG', clip: c(0, 0, 0.5, 0.5) }, { page: 0, index: 0, name: 'EG', clip: c(0.5, 0, 1, 0.5) },
    { page: 0, index: 2, name: '2OG', clip: c(0, 0.5, 0.5, 1) }, { page: 0, index: -1, name: '1UG', clip: c(0.5, 0.5, 1, 1) },
  ]
  const a3 = (page: number) => ({ page, widthPt: 1191, heightPt: 842 })
  const drawings = sheetDrawings(floors, [a3(0)])
  const fire = (x: number, y: number, more: Partial<BoardAnno> = {}): BoardAnno => ({ id: 'f', kind: 'symbol', symbol: 'Feuer', x, y, ...more })

  it('S1: the drawings come from the binding that pinned THIS sheet, not the Gebäude\'s pack', () => {
    const modul6 = { ...inheritPlanBinding(sheet, approval, null, false, floors), page: 0 }
    const modul7 = { ...inheritPlanBinding({ ...sheet, id: 'object:wyss:plan:modul7', planId: 'modul7', datasetId: 'plan:wyss:modul7' }, approval, null, false, [{ page: 0, index: 5, name: '5OG' }]), page: 0 }
    const other = { ...inheritPlanBinding({ ...sheet, id: 'object:haus:plan:modul6', objectId: 'haus', datasetId: 'plan:haus:modul6' }, approval, null, false, [{ page: 0, index: 1, name: '1OG' }]), page: 0 }
    const bindings = [modul6, modul7, other]
    // a second floor-pack sheet of the same object, and the sheet of the object switched to
    expect(sheetFloorsOf(bindings, '/api/reference/plan%3Awyss%3Amodul7?v=2')).toBe(modul7.floors)
    expect(sheetFloorsOf(bindings, '/api/reference/plan%3Ahaus%3Amodul6?v=2')).toBe(other.floors)
    expect(sheetFloorsOf(bindings, '/api/reference/plan%3Awyss%3Amodul6?v=2')).toBe(modul6.floors)
    // another revision of the same dataset is another sheet; so is an unbound one
    expect(sheetFloorsOf(bindings, '/api/reference/plan%3Awyss%3Amodul6?v=1')).toBeUndefined()
    expect(sheetFloorsOf(bindings, '/plans/modul2.pdf')).toBeUndefined()
  })
  it('one page: the drawings are the clips as they are; none without floors or pages', () => {
    expect(drawings.map((d) => d.storey).sort()).toEqual([-1, 0, 2, 3])
    expect(drawings.find((d) => d.storey === 2)?.clip).toEqual([0, 0.5, 0.5, 1])
    expect(sheetDrawings(undefined, [a3(0)])).toEqual([])
    expect(sheetDrawings(floors, null)).toEqual([])
  })
  it('S2: every page stitched – a drawing on page 2 lies where the board stacks page 2', () => {
    // one storey per page, the whole document on the board (no #page): EG on top, 1OG below it
    const perPage = [{ page: 0, index: 0, name: 'EG' }, { page: 1, index: 1, name: '1OG', clip: c(0, 0.5, 0.5, 1) }]
    const stitched = sheetDrawings(perPage, [a3(0), a3(1)])
    expect(stitched).toEqual([
      { storey: 0, part: 0, clip: [0, 0, 1, 0.5] },
      { storey: 1, part: 0, clip: [0, 0.75, 0.5, 1] },
    ])
    // a Feuer placed in the 1OG drawing – the board's lower quarter, left – is on the 1. OG
    expect(withDrawingStorey(null, fire(0.25, 0.9), stitched)).toMatchObject({ storey: 1 })
    // …and the lower half's right side is page 2 OUTSIDE its drawing: no storey
    expect('storey' in withDrawingStorey(null, fire(0.75, 0.6), stitched)).toBe(false)
    // a narrower page is centred, as the bake stitches it
    expect(sheetDrawings(perPage, [a3(0), { page: 1, widthPt: 595.5, heightPt: 842 }])[1].clip).toEqual([0.25, 0.75, 0.5, 1])
    // a `#page=2` sheet shows that page alone: its drawings, and only its
    expect(sheetDrawings(perPage, [a3(1)])).toEqual([{ storey: 1, part: 0, clip: [0, 0.5, 0.5, 1] }])
  })
  it('a symbol placed in the 2OG drawing is on the 2OG; outside every drawing it has none', () => {
    expect(withDrawingStorey(null, fire(0.25, 0.75), drawings)).toMatchObject({ storey: 2 })
    expect(withDrawingStorey(null, fire(0.25, 0.75), drawings).floorFrom).toBeUndefined()
    expect('storey' in withDrawingStorey(null, fire(1.2, 0.75), drawings)).toBe(false)
    // a Linie or a note is not a symbol
    expect(withDrawingStorey(null, { id: 't', kind: 'text', x: 0.25, y: 0.75 }, drawings).storey).toBeUndefined()
  })
  it('moved into another drawing it changes storey; within its drawing a storey set by hand stays', () => {
    const onEg = fire(0.75, 0.25, { storey: 0 })
    expect(withDrawingStorey(onEg, { ...onEg, x: 0.75, y: 0.75 }, drawings)).toMatchObject({ storey: -1 })
    const byHand = fire(0.75, 0.25, { storey: 5 })
    expect(withDrawingStorey(byHand, { ...byHand, x: 0.8, y: 0.3 }, drawings).storey).toBe(5)
    expect(withDrawingStorey(byHand, { ...byHand, x: 1.3, y: 0.3 }, drawings).storey).toBe(5) // off every drawing
  })
  it('S4: two drawings of ONE storey are two drawings – wing to wing takes the storey, a span moves by none', () => {
    const wings = sheetDrawings([
      { page: 0, index: 1, part: 0, name: 'Westflügel', clip: c(0, 0, 0.5, 1) },
      { page: 0, index: 1, part: 1, name: 'Ostflügel', clip: c(0.5, 0, 1, 1) },
    ], [a3(0)])
    const byHand = fire(0.25, 0.5, { storey: 5 })
    expect(withDrawingStorey(byHand, { ...byHand, x: 0.75 }, wings).storey).toBe(1)
    const stair = fire(0.25, 0.5, { floorFrom: 0, floorTo: 2 })
    expect(withDrawingStorey(stair, { ...stair, x: 0.75 }, wings)).toMatchObject({ floorFrom: 0, floorTo: 2 })
  })
  it('a span moves whole by the step between the drawings, as on the Gebäude', () => {
    const stair = fire(0.75, 0.25, { floorFrom: 0, floorTo: 1 })
    const out = withDrawingStorey(stair, { ...stair, x: 0.25, y: 0.75 }, drawings)
    expect(out).toMatchObject({ floorFrom: 2, floorTo: 3 })
    expect('storey' in out).toBe(false)
  })
  it('works from the symbol as the gesture found it: a streamed frame never shifts twice, and back home is home', () => {
    const stair = fire(0.75, 0.25, { floorFrom: 0, floorTo: 1 })
    const frame1 = withDrawingStorey(stair, { ...stair, x: 0.25, y: 0.75 }, drawings)
    expect(withDrawingStorey(stair, { ...frame1, x: 0.3, y: 0.8 }, drawings)).toMatchObject({ floorFrom: 2, floorTo: 3 })
    expect(withDrawingStorey(stair, { ...frame1, x: 0.75, y: 0.3 }, drawings)).toMatchObject({ floorFrom: 0, floorTo: 1 })
  })
  it('S3: the bar\'s turn keeps every storey – a member swung across a drawing\'s edge is not carried there', () => {
    const onEg = fire(0.55, 0.25, { storey: 0 })
    const swung = { ...onEg, x: 0.45, y: 0.25 } // now over the 3OG drawing
    expect(barStorey(onEg, swung, drawings, false, 30).storey).toBe(0)
    expect(barStorey(onEg, swung, drawings, false, 0).storey).toBe(3) // the same place by a move
    expect(barStorey(onEg, swung, drawings, true, 0)).toBe(swung) // the stack has its own step
  })
})
