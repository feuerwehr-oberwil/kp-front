// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Entity, LineAttachment, LngLat, Trupp } from '../types'
import { mapMagnetTargets, type MagnetScene } from './mapMagnetTargets'
import { useMapMagnet, type MapMagnetDeps } from './useMapMagnet'

vi.mock('../lib/haptics', () => ({ buzz: vi.fn() }))

/** a flat screen: 1° = 1000 px, no camera */
const flat = {
  project: ([lng, lat]: LngLat) => ({ x: lng * 1000, y: lat * 1000 }),
  unproject: ([x, y]: [number, number]) => ({ lng: x / 1000, lat: y / 1000 }),
}
const trupp = (id: string): Trupp => ({ id, name: `Leader ${id}`, entryPressureBar: 300, entryTime: '2026-10-25T10:00:00Z', lastContactTime: '2026-10-25T10:05:00Z', status: 'aktiv' })
const marker = (id: string, truppId: string, coord: LngLat): Entity => ({ id, kind: 'team', layer: 'taktisch', coord, label: id, truppId })

// A Punkte-mode Leitung tapped from one Trupp marker to another: the second tap is judged by the
// claim the first one made (the Plan's rule, usePlanDraft · planCandidatesAt), so one Leitung
// cannot get a Trupp at both ends. Wired the way MapView wires it: the target walk reads the
// hook's own `draftStart()` at event time.
describe('useMapMagnet — a node draft keeps its first tap\'s Trupp claim', () => {
  it('the second tap does not couple to another Trupp\'s marker', () => {
    const entities = [marker('mA', 'tA', [0, 0]), marker('mB', 'tB', [0.5, 0])]
    const scene: MagnetScene = { entities, drawings: [], attachmentLines: [], trupps: [trupp('tA'), trupp('tB')], layerPoints: [], zoom: 18, bearing: 0, symMul: 1 }
    const banked: { startAttachment?: LineAttachment; endAttachment?: LineAttachment } = {}
    const onPointAttachment = vi.fn((a?: LineAttachment) => { if (a) banked[taps === 0 ? 'startAttachment' : 'endAttachment'] = a })
    let taps = 0
    const deps = (): MapMagnetDeps => ({
      mapInst: { current: flat as unknown as MlMap },
      storedDrawings: [], entities,
      candidates: (src, at) => mapMagnetTargets(flat, scene, src, at, hook.current.draftStart()),
      draft: { kind: 'line', freehand: null, length: taps, onPointAttachment, startAttachment: banked.startAttachment },
      carry: { start: vi.fn(), move: vi.fn(), end: vi.fn() },
    })
    const { result: hook, rerender } = renderHook(() => useMapMagnet(deps()))
    const tap = (at: LngLat) => {
      act(() => { hook.current.updateDraftMagnet('start', at) })
      act(() => { hook.current.finishDraftNodeMagnet(at) })
      taps += 1
      rerender()
    }
    tap([0, 0])
    expect(banked.startAttachment?.target).toMatchObject({ kind: 'object', id: 'mA' })
    tap([0.5, 0])
    expect(onPointAttachment).toHaveBeenLastCalledWith(undefined)
    expect(banked.endAttachment).toBeUndefined()
  })
})

// A hydrant of the Hydranten Ebene is a magnet target exactly like a placed symbol (owner, Üben
// feedback 27.11.2026): the same ring, the same dwell, and the end hangs on the point.
describe('useMapMagnet — a line end on a hydrant of the Hydranten Ebene', () => {
  const hydrant = { layer: 'hydranten', id: '0', label: 'Hydrant 1234', at: [0.1, 0] as LngLat }
  const scene: MagnetScene = { entities: [], drawings: [], attachmentLines: [], trupps: [], layerPoints: [[hydrant]], zoom: 18, bearing: 0, symMul: 1 }
  const deps = (over: Partial<MapMagnetDeps>): MapMagnetDeps => ({
    mapInst: { current: flat as unknown as MlMap },
    storedDrawings: [], entities: [],
    candidates: (src, at) => mapMagnetTargets(flat, scene, src, at),
    draft: { kind: 'line', freehand: 'line', length: 0 },
    carry: { start: vi.fn(), move: vi.fn(), end: vi.fn() },
    ...over,
  })
  const onHydrant = { kind: 'layer', layer: 'hydranten', id: '0', label: 'Hydrant 1234', at: [0.1, 0] }

  it('a dragged end released on it after the ring has filled hangs on it', () => {
    vi.useFakeTimers()
    try {
      const onDrawingAttachment = vi.fn()
      const L = { id: 'L', kind: 'line' as const, coords: [[0, 0.05], [0.05, 0]] as LngLat[] }
      const { result } = renderHook(() => useMapMagnet(deps({ storedDrawings: [L], onDrawingAttachment })))
      act(() => { result.current.beginEndpointDrag('L', 'end', [0.05, 0]) })
      act(() => { result.current.moveEndpointDrag([0.095, 0]) })
      expect(result.current.endpointDrag?.candidate?.target).toEqual(onHydrant)
      act(() => { vi.advanceTimersByTime(500) })
      act(() => { result.current.finishEndpointDrag() })
      expect(onDrawingAttachment).toHaveBeenCalledOnce()
      expect(onDrawingAttachment).toHaveBeenCalledWith('L', 'end', expect.objectContaining({ target: onHydrant, routing: 'direct' }), [0.095, 0])
    } finally { vi.useRealTimers() }
  })

  it('a drawn stroke that ends on it ends on it', () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useMapMagnet(deps({})))
      act(() => { result.current.updateDraftMagnet('start', [0, 0.3]) })
      act(() => { result.current.updateDraftMagnet('move', [0.095, 0.005]) })
      act(() => { vi.advanceTimersByTime(500) })
      let out: ReturnType<typeof result.current.updateDraftMagnet> | undefined
      act(() => { out = result.current.updateDraftMagnet('end', [0.095, 0.005]) })
      expect(out).toEqual({ startAttachment: undefined, endAttachment: { target: onHydrant, routing: 'direct' } })
    } finally { vi.useRealTimers() }
  })
})
