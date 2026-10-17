// An object's plans as the app's plan documents, so «Karte & Objekte» wears the NavRail grammar
// (Karte · module monograms · Gebäude) with the same glyphs (lib/navRail · planGlyph,
// components/PlanGlyph) and the phone's «Pläne» chooser (components/PlanChooser).
//
// Current station data only: every document points at the plan's CURRENT revision
// (`referenceUrl(id, version)`). Nothing here binds a sheet to anything — a binding is an
// Einsatz's (lib/incidentPlanBindings), and the viewer has none.

import type { PlanDocument } from '../../types'
import { referenceUrl } from '../api/reference'
import type { StationObject, StationPlan } from '../api/stationReference'

/** the Gebäude stack's document id in the viewer */
export const GEBAEUDE_DOC = 'gebaeude'

/** «modul23» → «modul2-3» (the combined sheet's monogram reads «2/3»), else the module key as is */
export function planDocId(p: Pick<StationPlan, 'module' | 'id'>): string {
  const m = (p.module ?? '').trim().toLowerCase()
  const two = /^modul(\d)(\d)$/.exec(m)
  if (two) return `modul${two[1]}-${two[2]}`
  return m || p.id
}

export interface ViewerPlanDoc { doc: PlanDocument; plan: StationPlan | null }

/** The object's documents in rail order — its plans by module, then the Gebäude stack when the
 *  station prepared floors. `gebaeudeLabel` is the copy word for that tile. */
export function viewerPlanDocs(obj: Pick<StationObject, 'plans' | 'floors'>, gebaeudeLabel: string): ViewerPlanDoc[] {
  const seen = new Set<string>()
  const out: ViewerPlanDoc[] = []
  for (const p of obj.plans) {
    let id = planDocId(p)
    for (let n = 2; seen.has(id); n += 1) id = `${planDocId(p)}${n}`
    seen.add(id)
    out.push({
      plan: p,
      doc: { id, code: p.code, title: p.title, subtitle: '', imageUrl: referenceUrl(p.id, p.version), orientation: 'landscape' },
    })
  }
  if (obj.floors.length) {
    out.push({
      plan: null,
      doc: { id: GEBAEUDE_DOC, code: gebaeudeLabel, title: gebaeudeLabel, subtitle: '', imageUrl: '', orientation: 'portrait', floorStack: true, icon: 'floors' },
    })
  }
  return out
}
