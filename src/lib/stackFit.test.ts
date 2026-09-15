import { describe, expect, it } from 'vitest'
import { packPagePlacement, pagePlacement, stackGroundFit } from './stackFit'
import { fitSimilarity } from './georef'
import { TILE_AR } from './whiteboard'
import { fpBoxFrac } from './footprint'
import { joinShifts } from './floorPackBinding'
import type { PlanFloor } from './api/reference'

// a 40 m × 20 m hall, src box 40 m wide (spanM), north-up, two storeys
const building = {
  src: [[[0, 0], [1, 0], [1, 0.5], [0, 0.5]]] as [number, number][][],
  geo: { origin: [7.55, 47.51] as [number, number], spanM: 40 },
  floors: [0, 1], orientDeg: 0, northUp: true, ringAspect: 0.5,
}

describe('the Gebäude stack on the ground', () => {
  it('maps a tile point to the ground and back, alike for every storey', () => {
    const fit = stackGroundFit(building)!
    expect(fit).toBeTruthy()
    const p = fit.toMap({ x: 0.5, y: 0.5 }) // tile centre = footprint centre
    expect(p.lng).toBeCloseTo(7.55 + 20 / (111320 * Math.cos((47.51 * Math.PI) / 180)), 7)
    expect(p.lat).toBeCloseTo(47.51 - 10 / 110540, 7)
    const back = fit.toPlan(p)
    expect(back.x).toBeCloseTo(0.5, 6); expect(back.y).toBeCloseTo(0.5, 6)
    // the footprint box spans 90 % of the tile width: 40 m over 0.9 of a tile's width
    const { rw } = fpBoxFrac(0.5, 1, 2 * TILE_AR, 2)
    const a = fit.toMap({ x: 0.5 - rw / 2, y: 0.5 }), b = fit.toMap({ x: 0.5 + rw / 2, y: 0.5 })
    // the picker's metre constants and the fit's own projection differ by ~0.2 %: a decimetre on
    // a 40 m hall, invisible on the tile – the outline and the ink share the picker's frame anyway
    expect((b.lng - a.lng) * 111320 * Math.cos((47.51 * Math.PI) / 180)).toBeCloseTo(40, 0)
  })
  it('has no fit without a ground position', () => {
    expect(stackGroundFit({ ...building, geo: undefined })).toBeNull()
  })
  it('places a page whose fit IS the footprint box at the box corners', () => {
    const fit = stackGroundFit(building)!
    const { rw, rh } = fpBoxFrac(0.5, 1, 2 * TILE_AR, 2)
    // a "page" fit that maps its (0,0)/(1,1) exactly onto the footprint box in tile space
    const pageFit = fitSimilarity([
      { plan: { x: 0, y: 0 }, lngLat: fit.toMap({ x: 0.5 - rw / 2, y: 0.5 - rh / 2 }), kind: 'gesetzt' },
      { plan: { x: 1, y: 1 }, lngLat: fit.toMap({ x: 0.5 + rw / 2, y: 0.5 + rh / 2 }), kind: 'gesetzt' },
    ], 2)! // the box is 40 m × 20 m: width / height = 2
    const [o, px, py] = pagePlacement(building, 0, pageFit)!
    expect(o[0]).toBeCloseTo(0, 2); expect(o[1]).toBeCloseTo(0, 2)
    expect(px[0]).toBeCloseTo(1, 2); expect(px[1]).toBeCloseTo(0, 2)
    expect(py[0]).toBeCloseTo(0, 2); expect(py[1]).toBeCloseTo(1, 2)
  })
})

describe('the stack plan id', () => {
  it('is the Gebäude document\'s id – the projection rule keys on it', async () => {
    const { gebaeudeDoc } = await import('../data/demoIncident')
    const { GEBAEUDE_PLAN_ID } = await import('./whiteboard')
    expect(gebaeudeDoc.id).toBe(GEBAEUDE_PLAN_ID)
  })
})

describe('a pack stack – the pages ARE the tiles', () => {
  it('maps a tile point through the page box onto the pack fit', () => {
    // a 2:1 page whose fit puts (0,0) at the origin and one page width = 80 m east
    const pageFit = fitSimilarity([
      { plan: { x: 0, y: 0 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'gesetzt' },
      { plan: { x: 1, y: 0 }, lngLat: { lng: 7.55 + 80 / (111320 * Math.cos((47.51 * Math.PI) / 180)), lat: 47.51 }, kind: 'gesetzt' },
    ], 2)!
    const pack = { pack: { aspect: 2 }, ringAspect: 0.5, floors: [0, 1, 2], src: undefined, geo: undefined }
    const fit = stackGroundFit(pack, pageFit)!
    expect(fit).toBeTruthy()
    const { rw, rh } = fpBoxFrac(0.5, 1, 3 * TILE_AR, 3)
    const origin = fit.toMap({ x: 0.5 - rw / 2, y: 0.5 - rh / 2 }) // the page's top-left corner in the tile
    expect(origin.lng).toBeCloseTo(7.55, 5); expect(origin.lat).toBeCloseTo(47.51, 5)
    const east = fit.toMap({ x: 0.5 + rw / 2, y: 0.5 - rh / 2 })
    expect((east.lng - 7.55) * 111320 * Math.cos((47.51 * Math.PI) / 180)).toBeCloseTo(80, 0)
    expect(stackGroundFit(pack, null)).toBeNull()
  })
})


it('the PDF renderer puts joined staircases at identical XY without stretching the smaller floor', () => {
  const ground: PlanFloor = { index: 0, page: 0, name: null, clip: [.1, .3, .9, .8] }
  const upper: PlanFloor = { index: 1, page: 0, name: null, clip: [.5, .02, .8, .25], join: { to: 0, at: [.65, .15], there: [.7, .4] } }
  const shifts = joinShifts([ground, upper], ground)
  const at = (f: PlanFloor, point: [number, number]) => {
    const { corners: [o, x, y] } = packPagePlacement(ground.clip!, { url: '', clip: f.clip!, shift: shifts.get(f.index)! })
    return [o[0] + point[0] * (x[0] - o[0]) + point[1] * (y[0] - o[0]), o[1] + point[0] * (x[1] - o[1]) + point[1] * (y[1] - o[1])]
  }
  const up = at(upper, upper.join!.at), down = at(ground, upper.join!.there)
  expect(up[0]).toBeCloseTo(down[0], 10)
  expect(up[1]).toBeCloseTo(down[1], 10)
  const { clip } = packPagePlacement(ground.clip!, { url: '', clip: upper.clip!, shift: shifts.get(1)! })
  expect(clip[2]).toBeCloseTo(.3 / .8) // stays narrower than EG
})
