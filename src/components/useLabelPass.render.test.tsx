// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LngLat, Trupp } from '../types'
import { useLabelPass, type LabelPassScene } from './useLabelPass'

/*
 * The label arbitration (every label against every other) runs when the scene or the camera
 * changed – never per render. `runs` counts it by its first projection (the incident hub). The
 * chrome walls stay per render, read fresh (the chrome moves without telling the map).
 */

const HUB: LngLat = [7.5, 47.4]
const sym = (id: string, lng: number, notes = 'Wasserbezug Weiher'): Entity =>
  ({ id, kind: 'symbol', layer: 'taktisch', symbol: 'Hydrant', coord: [lng, 47.5], notes }) as Entity
const line: Drawing = { id: 'L', kind: 'line', coords: [[7.6, 47.5], [7.61, 47.5]], color: '#c00', width: 4, label: 'Abschnitt 1' } as Drawing

/** A scene as MapView builds it: every derived member a fresh array/Map on every render. */
const sceneOf = (over: Partial<LabelPassScene> = {}): LabelPassScene => ({
  initialCenter: [...HUB] as LngLat, entities, isVisible, zoom: 18, symMul: 1, captionMode: 'all',
  selectedId: null, selectedEntityIds: [], teamLines: new Map(), trupps, truppSeverities: {}, drawingsVisible: true,
  lineDecor: [], drawLabels: [{ id: 'L', coord: [7.605, 47.5], lines: [{ text: 'Abschnitt 1', words: true }] }],
  circleLabels: [], selectedDrawingId: null, storedDrawings, hiddenTrails, ...over,
})
const entities = [sym('A', 7.6), sym('B', 7.8)]
const storedDrawings = [line]
const trupps: Trupp[] = []
const hiddenTrails: ReadonlySet<string> = new Set()
const isVisible = () => true

/** A map that projects 1° = 1000 px and counts what the pass asks of it. */
function fakeMap() {
  const container = document.createElement('div')
  const reads = vi.spyOn(container, 'getBoundingClientRect')
  const project = vi.fn((c: [number, number]) => ({ x: c[0] * 1000, y: c[1] * 1000 }))
  const map = { project, getContainer: () => container } as unknown as MlMap
  return {
    map, reads: () => reads.mock.calls.length, projections: () => project.mock.calls.length,
    runs: () => project.mock.calls.filter(([c]) => c[0] === HUB[0] && c[1] === HUB[1]).length,
  }
}

afterEach(() => { document.body.innerHTML = '' })

const mount = (onCaptions?: (ids: ReadonlySet<string>) => void) => {
  const f = fakeMap()
  const ref = { current: f.map }
  const hook = renderHook(({ scene }: { scene: LabelPassScene }) => useLabelPass(ref, scene, onCaptions), { initialProps: { scene: sceneOf() } })
  return { ...f, hook }
}

describe('useLabelPass – decides only when something changed', () => {
  it('20 renders with an unchanged scene: 0 runs', () => {
    const { hook, runs } = mount()
    expect(runs()).toBe(1)
    for (let i = 0; i < 20; i++) hook.rerender({ scene: sceneOf() })
    expect(runs()).toBe(1)
  })

  it('moveend (bumpLabelFrame) decides once more – the label a pan or a drag hid comes back on release', () => {
    const { hook, runs } = mount()
    act(() => { hook.result.current.bumpLabelFrame() })
    expect(runs()).toBe(2)
    hook.rerender({ scene: sceneOf() })
    expect(runs()).toBe(2)
  })

  // the other side of the memo: every scene input, changed alone, decides again at once
  const changes: [string, Partial<LabelPassScene>][] = [
    ['initialCenter', { initialCenter: [7.7, 47.4] }],
    ['entities (a new object)', { entities: [...entities, sym('C', 7.64)] }],
    ['entities (a caption edit)', { entities: [sym('A', 7.6, 'Kein Wasser'), entities[1]] }],
    ['entities (a drag released)', { entities: [sym('A', 7.601), entities[1]] }],
    ['isVisible', { isVisible: () => false }],
    ['zoom', { zoom: 17 }],
    ['symMul', { symMul: 1.5 }],
    ['captionMode', { captionMode: 'off' }],
    ['selectedId', { selectedId: 'A' }],
    ['selectedEntityIds', { selectedEntityIds: ['A'] }],
    ['teamLines', { teamLines: new Map([['A', { lineId: 'L', color: '#c00', tone: 'warn', coupled: true }]]) }],
    ['trupps', { trupps: [{ id: 't1' } as Trupp] }],
    ['truppSeverities', { truppSeverities: { t1: 2 } }],
    ['drawingsVisible', { drawingsVisible: false }],
    ['lineDecor', { lineDecor: [{ d: line, tagAt: [7.61, 47.5], tagOffset: [8, 0], tone: 'idle' }] }],
    ['drawLabels', { drawLabels: [{ id: 'L', coord: [7.605, 47.5], lines: [{ text: 'Abschnitt 2', words: true }] }] }],
    ['circleLabels', { circleLabels: [{ id: 'K', coord: [7.6, 47.51], text: '50 m' }] }],
    ['selectedDrawingId', { selectedDrawingId: 'L' }],
    ['storedDrawings', { storedDrawings: [{ ...line, labelAt: [7.605, 47.501] }] }],
    ['hiddenTrails', { hiddenTrails: new Set(['A']) }],
  ]
  it.each(changes)('a changed %s decides again', (_name, over) => {
    // counted by all projections: a moved hub is not the hub `runs` looks for
    const { hook, projections } = mount()
    const one = projections()
    hook.rerender({ scene: sceneOf(over) })
    const two = projections()
    expect(two).toBeGreaterThan(one)
    hook.rerender({ scene: sceneOf(over) })
    expect(projections()).toBe(two)
  })
})

describe('useLabelPass – the chrome is a wall on every render', () => {
  it('a rail that comes over a readout takes it off on the next render, with no new run', () => {
    // a readout on open ground, at x 7700, bottom edge y 47490 (1° = 1000 px)
    const scene = () => sceneOf({ drawLabels: [{ id: 'L', coord: [7.7, 47.5], lines: [{ text: 'Abschnitt 1', words: true }] }] })
    const { hook, runs, reads } = mount()
    hook.rerender({ scene: scene() })
    expect(hook.result.current.suppressedLabels.has('dl:L')).toBe(false)
    const before = runs()
    const rail = document.createElement('nav')
    rail.className = 'rail'
    rail.getBoundingClientRect = () => ({ left: 7600, top: 47400, width: 200, height: 200, right: 7800, bottom: 47600, x: 7600, y: 47400, toJSON: () => ({}) })
    document.body.append(rail)
    hook.rerender({ scene: scene() })
    expect(hook.result.current.suppressedLabels.has('dl:L')).toBe(true)
    expect(runs()).toBe(before)
    expect(reads()).toBe(3)
    rail.remove()
    hook.rerender({ scene: scene() })
    expect(hook.result.current.suppressedLabels.has('dl:L')).toBe(false)
  })
})

describe('useLabelPass – the plan twins hear of the hidden captions only when the set changes', () => {
  it('once on mount, never on a re-render, once when a caption goes', () => {
    const heard = vi.fn()
    const { hook } = mount(heard)
    expect(heard).toHaveBeenCalledTimes(1)
    expect([...heard.mock.calls[0][0] as Set<string>]).toEqual([])
    for (let i = 0; i < 5; i++) hook.rerender({ scene: sceneOf() })
    expect(heard).toHaveBeenCalledTimes(1)
    // B's caption stood clear of A; moved under A's caption, one of the two must yield
    hook.rerender({ scene: sceneOf({ entities: [entities[0], sym('B', 7.605, 'Wasserbezug Weiher Nord')] }) })
    expect(heard).toHaveBeenCalledTimes(2)
    expect((heard.mock.calls[1][0] as Set<string>).size).toBe(1)
  })
})
