// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Drawing, Entity, LngLat, Trupp } from '../types'
import { useLabelPass, type LabelPassScene } from './useLabelPass'

/*
 * The label pass runs when something it depends on changed – never per render (perf sweep finding
 * 20). Each run reads the chrome's layout (the container's rect, then every chrome element's) and
 * compares every label with every other, so the counts here are the cost: `reads` = the container
 * rect a chrome read starts with, `runs` = the pass's first projection (the incident hub).
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
    map, reads: () => reads.mock.calls.length,
    runs: () => project.mock.calls.filter(([c]) => c[0] === HUB[0] && c[1] === HUB[1]).length,
  }
}

/** ResizeObserver stand-in: what it watches, and a way to report a size change. It reports nothing
 *  on its own, so the counts below leave out the first report a real one makes on observe. */
const ro = { observed: [] as Element[], report: [] as (() => void)[] }
class FakeRO {
  constructor(private cb: () => void) { ro.report.push(() => this.cb()) }
  observe(el: Element) { ro.observed.push(el) }
  disconnect() {}
}
beforeEach(() => { ro.observed.length = 0; ro.report.length = 0; vi.stubGlobal('ResizeObserver', FakeRO) })
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

const mount = (onCaptions?: (ids: ReadonlySet<string>) => void) => {
  const f = fakeMap()
  const ref = { current: f.map }
  const hook = renderHook(({ scene }: { scene: LabelPassScene }) => useLabelPass(ref, scene, onCaptions), { initialProps: { scene: sceneOf() } })
  return { ...f, hook }
}

describe('useLabelPass – decides only when something changed', () => {
  it('20 renders with an unchanged scene: 0 chrome reads, 0 runs', () => {
    const { hook, reads, runs } = mount()
    expect([reads(), runs()]).toEqual([1, 1])
    for (let i = 0; i < 20; i++) hook.rerender({ scene: sceneOf() })
    expect([reads(), runs()]).toEqual([1, 1])
  })

  it('moveend (bumpLabelFrame) decides once more – the label a pan or a drag hid comes back on release', () => {
    const { hook, reads, runs } = mount()
    act(() => { hook.result.current.bumpLabelFrame() })
    expect([reads(), runs()]).toEqual([2, 2])
    hook.rerender({ scene: sceneOf() })
    expect([reads(), runs()]).toEqual([2, 2])
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
    // counted by the chrome read each run starts with: a moved hub is not the hub `runs` looks for
    const { hook, reads } = mount()
    hook.rerender({ scene: sceneOf(over) })
    expect(reads()).toBe(2)
    hook.rerender({ scene: sceneOf(over) })
    expect(reads()).toBe(2)
  })
})

describe('useLabelPass – a chrome change decides again', () => {
  it('the map container resizes', () => {
    const { runs, map } = mount()
    expect(ro.observed).toEqual([map.getContainer()])
    act(() => { ro.report[ro.report.length - 1]() })
    expect(runs()).toBe(2)
  })

  it('a rail opens (a chrome element changes size)', () => {
    document.body.innerHTML = '<div class="topbar"></div><nav class="rail"></nav>'
    const { hook, runs } = mount()
    expect(ro.observed.map((el) => el.className)).toEqual(['', 'topbar', 'rail'])
    act(() => { ro.report[ro.report.length - 1]() })
    expect(runs()).toBe(2)
    hook.rerender({ scene: sceneOf() })
    expect(runs()).toBe(2)
  })

  it('a phone read-out appears: it is watched from the next commit, and its first report decides again', () => {
    document.body.innerHTML = '<div class="topbar"></div>'
    const { hook, runs } = mount()
    const watchers = ro.report.length
    hook.rerender({ scene: sceneOf() })
    expect(ro.report).toHaveLength(watchers) // same chrome, no new watcher
    document.body.insertAdjacentHTML('beforeend', '<div class="phone-wx"></div>')
    hook.rerender({ scene: sceneOf() })
    expect(ro.observed.some((el) => el.className === 'phone-wx')).toBe(true)
    act(() => { ro.report[ro.report.length - 1]() })
    expect(runs()).toBe(2)
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
