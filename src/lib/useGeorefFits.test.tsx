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

// Modul 6 of a building, two A3 pages stitched on one board: 1OG = page 1, EG = page 2 – the
// approved fit's page, measured by the station on that ONE page
const pairs: GeorefPair[] = [
  { plan: { x: 0.1, y: 0.8 }, lngLat: { lng: 7.555, lat: 47.511 }, kind: 'gesetzt' },
  { plan: { x: 0.9, y: 0.8 }, lngLat: { lng: 7.556, lat: 47.5117 }, kind: 'gesetzt' },
]
const sheet = { id: 'object:wyss:plan:modul6', objectId: 'wyss', planId: 'modul6', datasetId: 'plan:wyss:modul6', planVersion: 2, title: 'Modul 6' }
const floors = [{ page: 0, index: 1, name: '1OG' }, { page: 1, index: 0, name: 'EG' }]
const bound = inheritPlanBinding(sheet, { id: 1, page: 1, pairs, aspect: 1.414, approved_at: '2026-09-14' }, null, false, floors)
const url = referenceUrl(sheet.datasetId, sheet.planVersion)
const modul6: PlanDocument = { id: 'modul6', code: 'M6', title: 'Modul 6', subtitle: '', imageUrl: url, orientation: 'landscape', georefKey: incidentGeorefKey('inc', bound.id) }
const a3 = (page: number) => ({ page, widthPt: 1191, heightPt: 842 })

// the hook as the workspace calls it, with only the plan side filled in
function useFits(planBindings: IncidentPlanBinding[]) {
  return useGeorefFits({
    planDocs: [modul6], planScale: {}, building: null, setBuilding: () => {}, planBindings, activeObjectId: 'wyss',
    board: {}, objects: [], rebake: vi.fn(), planFitsRef: { current: new Map<string, PlanFit>() }, fitsVersion: 0,
    setFitsVersion: () => {}, stepLabelRef: { current: null }, histSide: { current: { log: () => {} } },
    readOnly: false, canWriteBlob: false, tacticalLocked: false, replayActive: false, twinLayers: {}, twinLayerOpacity: {},
    activePlanId: 'modul6', liveVehicles: [], livePeople: { people: [] }, isVisible: () => true, mapEntities: [],
  })
}

describe('a sheet\'s pages and its binding, in either order (FLOORS4, 19.11.2026)', () => {
  it('pages first, binding later: the storey drawings and the board-page fit appear', () => {
    let bindings: IncidentPlanBinding[] = []
    const unregister = registerIncidentPlanBindings('inc', { get bindings() { return bindings }, save: () => {} })
    try {
      const { result, rerender } = renderHook(({ b }) => useFits(b), { initialProps: { b: bindings } })
      // the renderer tells its pages while the sheet's binding is not known yet
      act(() => { result.current.sheetPack.onPages(url, [a3(0), a3(1)]) })
      expect(result.current.sheetPack.drawings).toEqual([])
      expect(result.current.linkedPlans).toEqual([])

      bindings = [bound]
      rerender({ b: bindings })
      expect(result.current.sheetPack.drawings.map((d) => d.storey)).toEqual([1, 0])
      // the station's page-2 pairs lie in the board's lower half: page (x, y) = board (x, 0.5 + y / 2)
      const [plan] = result.current.linkedPlans
      for (const p of pairs) {
        const at = plan.fit.toMap({ x: p.plan.x, y: 0.5 + p.plan.y / 2 })
        expect(at.lng).toBeCloseTo(p.lngLat.lng, 9); expect(at.lat).toBeCloseTo(p.lngLat.lat, 9)
      }
    } finally { unregister() }
  })
})
