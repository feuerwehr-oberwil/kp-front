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
    const scene: MagnetScene = { entities, drawings: [], attachmentLines: [], trupps: [trupp('tA'), trupp('tB')], zoom: 18, bearing: 0, symMul: 1 }
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
