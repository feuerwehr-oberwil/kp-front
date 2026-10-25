import { describe, expect, it } from 'vitest'
import type { LngLat } from '../types'
import { routeMapClick, type ClickFeature, type MapClickInput } from './mapClick'

/** a flat screen: 1° = 1000 px, no camera */
const flat = ([lng, lat]: LngLat) => ({ x: lng * 1000, y: lat * 1000 })
const click = (over: Partial<MapClickInput>): MapClickInput => ({
  at: [0.05, 0], point: { x: 50, y: 0 }, features: [], georefOn: false, picking: false,
  measure: null, edit: null, draft: null, placing: false, lockedIds: new Set(), ...over,
})
/** a square Fläche feature of side `s`° at the origin */
const area = (id: string, s: number, props: Record<string, unknown> = {}): ClickFeature => ({
  layer: { id: 'l-draw-fill' }, properties: { id, ...props },
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [s, 0], [s, s], [0, s]]] },
})
const lineFeature = (id: string): ClickFeature => ({ layer: { id: 'l-draw-hit' }, properties: { id }, geometry: { type: 'LineString', coordinates: [] } })

describe('routeMapClick — who owns a click', () => {
  it('the pairing mode swallows it, the coordinate picker takes it before anything under it', () => {
    const under = [area('A', 1)]
    expect(routeMapClick(click({ georefOn: true, picking: true, features: under }), flat)).toEqual({ kind: 'none' })
    expect(routeMapClick(click({ picking: true, features: under }), flat)).toEqual({ kind: 'pick', at: [0.05, 0] })
  })

  it('a tap on the Messen path inserts a node on the segment it landed on', () => {
    const measure = { points: [[0, 0], [0.1, 0], [0.1, 0.1]] as LngLat[], isArea: false, canInsert: true }
    const onPath = click({ measure, features: [{ layer: { id: 'l-measure-hit' } }] })
    expect(routeMapClick(onPath, flat)).toEqual({ kind: 'measureInsert', index: 1, at: [0.05, 0] })
    // …but not before the map is up: nothing to measure against, so it falls through to a placement
    expect(routeMapClick({ ...onPath, placing: true }, null)).toEqual({ kind: 'place', at: [0.05, 0] })
  })
})

describe('routeMapClick — selecting what lies under the finger', () => {
  it('the SMALLEST shape wins, a line beats any fill, and a locked one is click-through', () => {
    const big = area('big', 1), small = area('small', 0.2)
    expect(routeMapClick(click({ features: [big, small] }), flat)).toMatchObject({ kind: 'selectDrawing', id: 'small' })
    expect(routeMapClick(click({ features: [small, lineFeature('L')] }), flat)).toMatchObject({ kind: 'selectDrawing', id: 'L' })
    expect(routeMapClick(click({ features: [big, small], lockedIds: new Set(['small']) }), flat)).toMatchObject({ kind: 'selectDrawing', id: 'big' })
  })

  it('a plan twin competes by the same rule, unless its source is locked', () => {
    const twin = area('tw', 0.2, { twinKey: 'k' })
    expect(routeMapClick(click({ features: [area('big', 1), twin] }), flat)).toMatchObject({ kind: 'selectDrawing', id: 'tw' })
    expect(routeMapClick(click({ features: [area('big', 1), { ...twin, properties: { ...twin.properties, locked: true } }] }), flat))
      .toMatchObject({ kind: 'selectDrawing', id: 'big' })
  })

  it('with a placement tool armed the click places, even inside a Fläche', () => {
    expect(routeMapClick(click({ placing: true, features: [area('A', 1)] }), flat)).toEqual({ kind: 'place', at: [0.05, 0] })
  })

  it('a tap on the draft\'s last node is the second half of a double tap, not a new corner', () => {
    const draft = { points: [[0, 0], [0.05, 0.01]] as LngLat[], isArea: false, canInsert: true }
    expect(routeMapClick(click({ placing: true, draft }), flat)).toEqual({ kind: 'none' })
    expect(routeMapClick(click({ placing: true, draft, point: { x: 50, y: 40 }, at: [0.05, 0.04] }), flat)).toEqual({ kind: 'place', at: [0.05, 0.04] })
  })
})
