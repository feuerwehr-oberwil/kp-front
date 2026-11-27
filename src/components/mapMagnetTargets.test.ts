// @vitest-environment jsdom
// (a Trupp marker's strip is measured with the label pass's canvas, which needs a `document`)
import { describe, expect, it } from 'vitest'
import type { Drawing, Entity, LineAttachment, LngLat, Trupp } from '../types'
import { DRAFT_SOURCE, mapMagnetTargets, type MagnetScene, type MapProjector } from './mapMagnetTargets'

/** a flat screen: 1° = 1000 px, no camera */
const flat: MapProjector = {
  project: ([lng, lat]) => ({ x: lng * 1000, y: lat * 1000 }),
  unproject: ([x, y]) => ({ lng: x / 1000, lat: y / 1000 }),
}
const trupp = (id: string): Trupp => ({ id, name: `Leader ${id}`, entryPressureBar: 300, entryTime: '2026-10-25T10:00:00Z', lastContactTime: '2026-10-25T10:05:00Z', status: 'aktiv' })
const marker = (id: string, truppId: string, coord: LngLat): Entity => ({ id, kind: 'team', layer: 'taktisch', coord, label: id, truppId })
const hydrant: Entity = { id: 'h', kind: 'symbol', layer: 'taktisch', coord: [0.2, 0.2], symbol: 'Hydrant' }
const line = (id: string, coords: LngLat[], over: Partial<Drawing> = {}): Drawing => ({ id, kind: 'line', coords, ...over } as Drawing)
const scene = (over: Partial<MagnetScene>): MagnetScene => ({
  entities: [], drawings: [], attachmentLines: [], trupps: [trupp('tA'), trupp('tB')], layerPoints: [], zoom: 18, bearing: 0, symMul: 1, ...over,
})
const keys = (s: MagnetScene, sourceId: string, draftStart?: LineAttachment) =>
  mapMagnetTargets(flat, s, sourceId, [0, 0], draftStart).map((t) => t.key)

describe('mapMagnetTargets — one Leitung, one Trupp, already at the magnet', () => {
  const entities = [marker('mA', 'tA', [0.1, 0]), marker('mB', 'tB', [0.3, 0]), hydrant]

  it('a Leitung with a crew does not offer another Trupp\'s marker — its own, and symbols, stay', () => {
    const held = line('L1', [[0, 0], [0.05, 0]], { truppId: 'tA' })
    expect(keys(scene({ entities, drawings: [held] }), 'L1')).toEqual(['object:mA', 'object:h'])
  })

  it('a draft is judged by the claim its first end already made', () => {
    const s = scene({ entities })
    const onA: LineAttachment = { target: { kind: 'object', id: 'mA' }, routing: 'direct' }
    expect(keys(s, DRAFT_SOURCE)).toEqual(['object:mA', 'object:mB', 'object:h'])
    expect(keys(s, DRAFT_SOURCE, onA)).toEqual(['object:mA', 'object:h'])
  })
})

describe('mapMagnetTargets — where each target is aimed at', () => {
  it('a Trupp marker is «hit» anywhere along its [dot][name] strip, not only on the dot', () => {
    const s = scene({ entities: [marker('Trupp 1', 'tA', [0, 0])] })
    // a pointer over the name, right of the dot: the target point is the pointer itself
    const [t] = mapMagnetTargets(flat, s, DRAFT_SOURCE, [0.02, 0.005])
    expect(t.point).toEqual([20, 5])
  })

  it('offers the other lines\' free ends, never the source line\'s own, and maps them back to the ground', () => {
    const own = line('L1', [[0, 0], [0.05, 0]])
    const other = line('L2', [[0.1, 0.1], [0.2, 0.1]])
    const s = scene({ drawings: [own, other], attachmentLines: [own, other].map((d) => ({ id: d.id, points: d.coords })) })
    const targets = mapMagnetTargets(flat, s, 'L1', [0, 0])
    expect(targets.map((t) => t.key)).toEqual(['line:L2:start:0', 'line:L2:end:0'])
    expect(targets[1].at).toEqual([0.2, 0.1])
  })
})

// owner, Üben feedback 27.11.2026: what the map does not show, no end can couple to
describe('mapMagnetTargets — hidden is no magnet', () => {
  it('a symbol, a vehicle and a Trupp marker on a switched-off layer are not offered; the shown ones are', () => {
    const vehicle: Entity = { id: 'v', kind: 'vehicle', layer: 'fahrzeuge', coord: [0.1, 0.1], label: 'TLF' }
    const entities = [hydrant, vehicle, marker('mA', 'tA', [0.1, 0])]
    expect(keys(scene({ entities }), DRAFT_SOURCE)).toEqual(['object:h', 'object:v', 'object:mA'])
    expect(keys(scene({ entities, entityShown: (e) => e.id === 'v' }), DRAFT_SOURCE)).toEqual(['object:v'])
  })

  it('with the Zeichnungen off, no line end is offered', () => {
    const other = line('L2', [[0.1, 0.1], [0.2, 0.1]])
    const s = { drawings: [other], attachmentLines: [{ id: other.id, points: other.coords }] }
    expect(keys(scene(s), DRAFT_SOURCE)).toEqual(['line:L2:start:0', 'line:L2:end:0'])
    expect(keys(scene({ ...s, linesShown: false }), DRAFT_SOURCE)).toEqual([])
  })
})

describe('mapMagnetTargets — the points of a symbol Ebene (Hydranten)', () => {
  const near = { layer: 'hydranten', id: '0', label: 'Hydrant 1234', at: [0.03, 0] as LngLat } // 30 px off
  const far = { layer: 'hydranten', id: '1', label: 'Hydrant', at: [5, 5] as LngLat }

  it('offers a hydrant in reach at its white plate\'s edge, as a symbol offers its glyph box', () => {
    const [t, ...rest] = mapMagnetTargets(flat, scene({ layerPoints: [[near, far]] }), DRAFT_SOURCE, [0, 0])
    expect(rest).toEqual([])
    expect(t).toMatchObject({ key: 'layer:hydranten:0', target: { kind: 'layer', ...near }, defaultRouting: 'direct' })
    // z18: the plate is ≈ 11.8 px in radius; the point stands 5 px outside it, toward the finger
    expect(t.point[0]).toBeCloseTo(30 - 11.8 - 5, 0)
    expect(t.point[1]).toBeCloseTo(0)
  })

  it('a hydrant under a placed symbol is that symbol\'s: only the symbol is offered', () => {
    const placed: Entity = { ...hydrant, coord: near.at }
    expect(keys(scene({ entities: [placed], layerPoints: [[near]] }), DRAFT_SOURCE)).toEqual(['object:h'])
    // …only while that symbol is drawn: on a switched-off layer it covers nothing, and is no magnet
    expect(keys(scene({ entities: [placed], layerPoints: [[near]], entityShown: () => false }), DRAFT_SOURCE)).toEqual(['layer:hydranten:0'])
  })

  it('projects only the points inside the magnet\'s reach — a district\'s hydrants are not walked', () => {
    let projected = 0
    const counting: MapProjector = { ...flat, project: (c) => { projected += 1; return flat.project(c) } }
    mapMagnetTargets(counting, scene({ layerPoints: [[near, ...Array.from({ length: 500 }, (_, i) => ({ ...far, id: String(i + 1) }))]] }), DRAFT_SOURCE, [0, 0])
    expect(projected).toBe(2) // the pointer and the one hydrant in reach
  })
})
