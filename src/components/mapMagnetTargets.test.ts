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
  entities: [], drawings: [], attachmentLines: [], trupps: [trupp('tA'), trupp('tB')], zoom: 18, bearing: 0, symMul: 1, ...over,
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
