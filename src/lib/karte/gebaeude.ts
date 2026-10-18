// «Karte & Objekte» — an object's Gebäude, 1:1 the Einsatz's (owner, review round 4, 17.10.2026:
// «gebäude should be literally 1:1 the same as in the normal incident just without editing";
// docs/karte-objekte.md · The viewer).
//
// An Einsatz gets its Gebäude from the plan binding it froze for the active object
// (lib/useObjectPlans → lib/floorPackBinding · floorPackOf → useGeorefFits seeds the building with
// `packBuildingDoc`). The viewer has no Einsatz and binds nothing, so it builds the SAME binding
// in memory — same rule for which approval counts, same floors — and never stores it anywhere.
// Everything after it (the pack view, the frame, the building, the Whiteboard) is the Einsatz's
// own code (components/karte/KartePlans · KarteGebaeudeBoard). Pure.

import type { PlanAlignmentMetadata } from '../api/reference'
import type { StationObject } from '../api/stationReference'
import { inheritPlanBinding, type IncidentPlanBinding } from '../incidentPlanBindings'
import { planKey } from './availability'
import { planDocId } from './plans'

/** The id an Einsatz binds this sheet under (lib/useObjectPlans · objectPlanGeorefKey — spelt
 *  here so a pure module does not pull the Einsatz's hook in; gebaeude.test pins the two equal). */
export const sheetBindingId = (objectId: string, planId: string) => `object:${objectId}:plan:${planId}`

/**
 * The binding an Einsatz would freeze for this object's floor pack, from each plan revision's
 * published metadata (`metas`, by `planKey`): the first plan, in the catalogue's order, whose
 * metadata names floors — as `useObjectPlans` binds them: the approval on page 0, else (a floor
 * pack's one fit may sit on any of its floor pages) the first approval with an aspect.
 *
 * `pageAspect` stands in for the approval's page aspect when the station has not approved a fit
 * (the Einsatz then has no stack at all; the viewer still shows the storeys, read from the page's
 * own size — the tile manifest's). Null when the object has no floors, or no aspect is known.
 */
export function objectFloorBinding(
  obj: Pick<StationObject, 'id' | 'plans'>,
  metas: ReadonlyMap<string, PlanAlignmentMetadata>,
  pageAspect?: (planKeyOf: string, page: number) => number | null | undefined,
): IncidentPlanBinding | null {
  for (const p of obj.plans) {
    const meta = metas.get(planKey(p))
    const floors = meta?.floors?.length ? meta.floors : undefined
    if (!meta || !floors) continue
    const approved = meta.alignments.find((a) => a.page === 0 && a.aspect > 0) ?? meta.alignments.find((a) => a.aspect > 0)
    const planId = planDocId(p)
    const b = inheritPlanBinding({
      id: sheetBindingId(obj.id, planId), objectId: obj.id, planId,
      datasetId: p.id, planVersion: p.version, title: p.title ?? planId,
    }, approved, null, false, floors)
    if (b.aspect) return b
    const page = floors[0].page
    const aspect = pageAspect?.(planKey(p), page)
    return aspect ? { ...b, page, aspect } : null
  }
  return null
}
