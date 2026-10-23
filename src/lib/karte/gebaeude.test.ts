import { describe, expect, it } from 'vitest'
import type { PlanAlignmentMetadata } from '../api/reference'
import type { StationPlan } from '../api/stationReference'
import { floorPackOf, packBuildingDoc } from '../floorPackBinding'
import { objectPlanGeorefKey } from '../useObjectPlans'
import { planKey } from './availability'
import { objectFloorBinding, sheetBindingId } from './gebaeude'

// Synthetic station data only (the mockup's Musterdorf).
const plan = (module: string, version = 1): StationPlan => ({
  id: `plan:schloss:${module}`, module, code: module.replace('modul', ''), title: `Schloss – ${module}`, pages: null, georef: false, version,
})
const M1 = plan('modul1')
const M6 = plan('modul6', 3)
const FLOORS = [
  { page: 0, index: 1, name: null, clip: [0.5, 0, 1, 0.5] as [number, number, number, number] },
  { page: 0, index: 0, name: 'EG / ZWG', clip: [0, 0, 0.5, 0.5] as [number, number, number, number] },
  { page: 0, index: -1, name: null, clip: [0, 0.5, 0.5, 1] as [number, number, number, number] },
]
const pairs = [
  { plan: { x: 0.1, y: 0.1 }, lngLat: { lng: 7.55, lat: 47.51 } },
  { plan: { x: 0.4, y: 0.4 }, lngLat: { lng: 7.551, lat: 47.509 } },
]
const meta = (p: StationPlan, o: Partial<PlanAlignmentMetadata> = {}): PlanAlignmentMetadata => ({
  dataset_id: p.id, plan_version: p.version, revision_url: '', floors: [], alignments: [], ...o,
})

// review round 4
describe('the Karte\'s Gebäude is the Einsatz\'s', () => {
  it('binds the floor pack the way an Einsatz does, under the same sheet id', () => {
    expect(sheetBindingId('o1', 'modul6')).toBe(objectPlanGeorefKey('o1', 'modul6'))
    const metas = new Map([
      [planKey(M1), meta(M1)],
      [planKey(M6), meta(M6, { floors: FLOORS, alignments: [{ id: 7, page: 0, pairs, aspect: 1.414, approved_at: '2026-10-01' }] })],
    ])
    const b = objectFloorBinding({ id: 'o1', plans: [M1, M6] }, metas)!
    expect(b).toMatchObject({ id: 'object:o1:plan:modul6', objectId: 'o1', planId: 'modul6', datasetId: M6.id, planVersion: 3, page: 0, aspect: 1.414, source: 'approved' })
    expect(b.floors).toEqual(FLOORS)
    // …and from there the Einsatz's own pipeline: the pack view and the stack it seeds
    const view = floorPackOf([b], 'o1')!
    const building = packBuildingDoc(view, view.frame, b.id)!
    expect(building.floors).toEqual([-1, 0, 1])
    expect(building.floorNames).toEqual({ 0: 'EG / ZWG' })
    expect(building.pack).toMatchObject({ bindingId: b.id, aspect: 1.414, frame: [0, 0, 0.5, 0.5] })
    expect(building.ring).toEqual([])
  })

  it('no floors anywhere → no Gebäude; metadata not known (offline, never asked) → none either', () => {
    expect(objectFloorBinding({ id: 'o1', plans: [M1, M6] }, new Map([[planKey(M1), meta(M1)]]))).toBeNull()
    expect(objectFloorBinding({ id: 'o1', plans: [M1, M6] }, new Map())).toBeNull()
  })

  it('a pack without an approved fit reads its page size instead — or shows nothing', () => {
    const metas = new Map([[planKey(M6), meta(M6, { floors: FLOORS })]])
    expect(objectFloorBinding({ id: 'o1', plans: [M6] }, metas)).toBeNull()
    const b = objectFloorBinding({ id: 'o1', plans: [M6] }, metas, (k, page) => (k === planKey(M6) && page === 0 ? 842 / 595 : null))!
    expect(b).toMatchObject({ aspect: 842 / 595, source: 'none', page: 0 })
    expect(b.georef.pairs).toEqual([])
    const view = floorPackOf([b], 'o1')!
    expect(view.fit).toBeNull()
    expect(packBuildingDoc(view, view.frame)?.floors).toEqual([-1, 0, 1])
  })
})

describe('packBuildingDoc — the one builder of a pack stack', () => {
  it('is what the Einsatz seeded before (useGeorefFits): ring-less, page-shaped, the band from the frame', () => {
    const view = { floors: FLOORS, aspect: 2 }
    const doc = packBuildingDoc(view, [0, 0, 1, 1], 'b1')!
    expect(doc).toMatchObject({ ring: [], rings: [], ringAspect: 0.5, floors: [-1, 0, 1], pack: { bindingId: 'b1', aspect: 2 } })
    // a whole-page frame is not written down
    expect(doc.pack).not.toHaveProperty('frame')
    expect(doc.tileAR).toBeGreaterThan(0)
    expect(packBuildingDoc({ floors: [], aspect: 2 }, [0, 0, 1, 1])).toBeNull()
    expect(packBuildingDoc({ floors: FLOORS, aspect: null }, [0, 0, 1, 1])).toBeNull()
  })
})
