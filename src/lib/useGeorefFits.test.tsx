// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { PlanDocument } from '../types'
import type { GeorefPair } from './georef'
import { incidentGeorefKey, inheritPlanBinding, registerIncidentPlanBindings, type IncidentPlanBinding } from './incidentPlanBindings'
import { referenceUrl } from './api/reference'
import type { PlanFit } from './tacticalObjects'
import { useGeorefFits } from './useGeorefFits'

afterEach(cleanup)

// Modul 6 of a building and its approved fit, measured by the station on the first page
const pairs: GeorefPair[] = [
  { plan: { x: 0.1, y: 0.8 }, lngLat: { lng: 7.555, lat: 47.511 }, kind: 'gesetzt' },
  { plan: { x: 0.9, y: 0.8 }, lngLat: { lng: 7.556, lat: 47.5117 }, kind: 'gesetzt' },
]
const sheet = { id: 'object:wyss:plan:modul6', objectId: 'wyss', planId: 'modul6', datasetId: 'plan:wyss:modul6', planVersion: 2, title: 'Modul 6' }
const approval = { id: 1, page: 0, pairs, aspect: 1.414, approved_at: '2026-09-14' }
// one page: EG right half (the reference), 1OG left half, joined at the staircase
const onePage = [
  { page: 0, index: 0, name: 'EG', clip: [0.5, 0, 1, 1] as [number, number, number, number] },
  { page: 0, index: 1, name: '1OG', clip: [0, 0, 0.5, 1] as [number, number, number, number], join: { to: 0, at: [0.2, 0.3] as [number, number], there: [0.7, 0.3] as [number, number] } },
]
// two pages: 1OG = page 1, EG = page 2
const twoPages = [{ page: 0, index: 1, name: '1OG' }, { page: 1, index: 0, name: 'EG' }]
const url = referenceUrl(sheet.datasetId, sheet.planVersion)
const a3 = (page: number) => ({ page, widthPt: 1191, heightPt: 842 })

// …and a plain Modul 2 beside it, linked by its own binding
const modul2Sheet = { ...sheet, id: 'object:wyss:plan:modul2', planId: 'modul2', datasetId: 'plan:wyss:modul2' }
const modul2Binding = inheritPlanBinding(modul2Sheet, approval, null, false)
// ONE identity, as the workspace's: a new array per render would re-run every fit effect
const planDocs: PlanDocument[] = [
  { id: 'modul6', code: 'M6', title: 'Modul 6', subtitle: '', imageUrl: url, orientation: 'landscape', georefKey: incidentGeorefKey('inc', sheet.id) },
  { id: 'modul2', code: 'M2', title: 'Modul 2', subtitle: '', imageUrl: referenceUrl(modul2Sheet.datasetId, 2), orientation: 'landscape', georefKey: incidentGeorefKey('inc', modul2Sheet.id) },
]

const planScale = {}

// the hook as the workspace calls it, with only the plan side filled in
function useFits(planBindings: IncidentPlanBinding[], planFitsRef: { current: Map<string, PlanFit> }, rebake: () => number) {
  return useGeorefFits({
    planDocs, planScale, building: null, setBuilding: () => {}, planBindings, activeObjectId: 'wyss',
    board: {}, objects: [], rebake, planFitsRef, fitsVersion: 0,
    setFitsVersion: () => {}, stepLabelRef: { current: null }, histSide: { current: { log: () => {} } },
    readOnly: false, canWriteBlob: false, tacticalLocked: false, replayActive: false, twinLayers: {}, twinLayerOpacity: {},
    activePlanId: 'modul6', liveVehicles: [], livePeople: { people: [] }, isVisible: () => true, mapEntities: [],
  })
}
function mount(first: IncidentPlanBinding) {
  const box = { bindings: [first, modul2Binding] }
  const unregister = registerIncidentPlanBindings('inc', { get bindings() { return box.bindings }, save: () => {} })
  const planFitsRef = { current: new Map<string, PlanFit>() }
  const rebake = vi.fn((_opts?: { checkpoint?: boolean; plans?: ReadonlySet<string> }) => 0)
  const hook = renderHook(({ b }) => useFits(b, planFitsRef, rebake), { initialProps: { b: box.bindings } })
  const bind = (b: IncidentPlanBinding) => { box.bindings = [b, modul2Binding]; hook.rerender({ b: box.bindings }) }
  return { ...hook, bind, planFitsRef, rebake, unregister }
}

describe('a sheet\'s pages and its floors, in either order (FLOORS4/5, 19.11.2026)', () => {
  it('one page, pages first, floors later: the drawings reach the bake with their join shifts', () => {
    const { result, bind, planFitsRef, unregister } = mount(inheritPlanBinding(sheet, approval, null, false))
    try {
      // the renderer tells its page while the binding has no floors yet
      act(() => { result.current.sheetPack.onPages(url, [a3(0)]) })
      expect(result.current.sheetPack.drawings).toEqual([])
      expect(planFitsRef.current.get('modul6')?.drawings).toBeUndefined()

      bind(inheritPlanBinding(sheet, approval, null, false, onePage))
      expect(result.current.sheetPack.drawings.map((d) => d.storey)).toEqual([0, 1])
      const [eg, og] = planFitsRef.current.get('modul6')?.drawings?.map((d) => d.shift) ?? []
      expect(eg).toEqual([0, 0]); expect(og?.[0]).toBeCloseTo(0.5); expect(og?.[1]).toBeCloseTo(0)
    } finally { unregister() }
  })
  it('a stitched two-page sheet: storeys on the sheet, and the fit as it was – no drawings in the bake', () => {
    const { result, planFitsRef, unregister } = mount(inheritPlanBinding(sheet, approval, null, false, twoPages))
    try {
      // floors on two pages: a stitched sheet, so its fit is not held back until it renders
      expect(planFitsRef.current.get('modul6')?.fit).toBeDefined()
      act(() => { result.current.sheetPack.onPages(url, [a3(0), a3(1)]) })
      expect(result.current.sheetPack.drawings.map((d) => d.storey)).toEqual([1, 0])
      const plan = planFitsRef.current.get('modul6')!
      expect(plan.drawings).toBeUndefined()
      // the station's pairs read as they are, as before #703
      for (const p of pairs) {
        const at = plan.fit.toMap(p.plan)
        expect(at.lng).toBeCloseTo(p.lngLat.lng, 9); expect(at.lat).toBeCloseTo(p.lngLat.lat, 9)
      }
    } finally { unregister() }
  })

  // Sol review #703 round 2, S1: a two-page PDF whose recorded floors all sit on page 1 – its fit
  // is held back until it renders, and the stitched pages then bring no shifted drawings
  it('S1: a held-back fit that becomes available reaches the bake, though no drawing shifts', () => {
    const { result, planFitsRef, rebake, unregister } = mount(inheritPlanBinding(sheet, approval, null, false, onePage))
    try {
      expect(planFitsRef.current.has('modul6')).toBe(false)
      expect(planFitsRef.current.has('modul2')).toBe(true)
      rebake.mockClear()
      act(() => { result.current.sheetPack.onPages(url, [a3(0), a3(1)]) })
      expect(planFitsRef.current.get('modul6')).toMatchObject({ fit: expect.anything() })
      expect(planFitsRef.current.get('modul6')?.drawings).toBeUndefined()
      expect(rebake).toHaveBeenCalledWith({ checkpoint: false, plans: new Set(['modul6']) })
    } finally { unregister() }
  })
  // S6: the silent bake is the drawings' – another sheet's fit is the normal effect's business
  it('S6: the drawings arriving re-bake their own sheet only', () => {
    const { result, rebake, unregister } = mount(inheritPlanBinding(sheet, approval, null, false, onePage))
    try {
      rebake.mockClear() // the seed bake of the mount
      act(() => { result.current.sheetPack.onPages(url, [a3(0)]) })
      expect(rebake.mock.calls).toEqual([[{ checkpoint: false, plans: new Set(['modul6']) }]])
    } finally { unregister() }
  })
})
