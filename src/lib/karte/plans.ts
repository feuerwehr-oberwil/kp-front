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
import type { DeploymentModule } from '../deploymentConfig'
import { planLabel } from '../navRail'
import { entryFor } from '../planOrder'

/** the Gebäude stack's document id in the viewer */
export const GEBAEUDE_DOC = 'gebaeude'

/** «modul23» → «modul2-3» (the combined sheet's monogram reads «2/3»), else the module key as is */
export function planDocId(p: Pick<StationPlan, 'module' | 'id'>): string {
  const m = (p.module ?? '').trim().toLowerCase()
  const two = /^modul(\d)(\d)$/.exec(m)
  if (two) return `modul${two[1]}-${two[2]}`
  return m || p.id
}

/** «Migros – modul2», «Sägestrasse 8 - Schulhaus Hüslimatt – modul2-3»: a title that is only the
 *  file name — whatever stands before the LAST dash, then the module key */
const FILE_TITLE = /(?:^|\s[–—-]\s*)(modul\s*\d[\w-]*)\s*$/i

/**
 * The words a plan's TITLE says — the open plan's head and the rail tile's spoken name (owner,
 * 17.10.2026 · R2; the tiles and the rail labels say only the plan's name, lib/navRail ·
 * planLabel). The station's pull titles many sheets «<object> – <module key>» — the file name, which only repeats the object the sheet already
 * stands under and ends in a key nobody says aloud. Such a title gives way to the module
 * catalogue's title for the key, the same catalogue the Einsatz's plan chooser labels its tiles
 * from (lib/planOrder · moduleCatalogue): «Migros – modul2» → «Wie komme ich herein». A clean
 * title («Übersicht», «Photovoltaik», «Gemeindehaus – Übersicht») is the station's word and stays.
 * A family sub-slot without its own entry says its own name («Wasser»), a numbered sibling keeps
 * its number («Wasser 2»), a key the catalogue does not know reads «Modul N». Pure.
 */
export function planTitle(p: Pick<StationPlan, 'module' | 'id' | 'title'>, catalogue: readonly DeploymentModule[]): string {
  const title = (p.title ?? '').trim()
  const file = FILE_TITLE.exec(title)
  if (title && !file) return title
  const id = p.module?.trim() ? planDocId(p) : file ? file[1].toLowerCase().replace(/\s+/g, '') : planDocId(p)
  const entry = entryFor(catalogue, id)
  const word = entry && !entry.family ? (entry.title ?? '').trim() : ''
  if (!word) return planLabel(id)
  // a numbered sibling (`modul5-wasser2`) is a second sheet of its slot, never a copy of the name
  const n = entry!.id !== id ? /(\d+)$/.exec(id)?.[1] : undefined
  return n ? `${word} ${n}` : word
}

/** `row`: the plan's name, the words its tile in the object's sheet and its rail tile say
 *  (lib/navRail · planLabel; «Gebäude» for the stack) */
export interface ViewerPlanDoc { doc: PlanDocument; plan: StationPlan | null; row: string }

/** The object's documents in rail order — its plans by module, then the Gebäude stack when the
 *  station prepared floors. `gebaeudeLabel` is the copy word for that tile; `catalogue` (the
 *  deployment's modules, lib/planOrder · moduleCatalogue) names each sheet (`planTitle`) and says
 *  which open in the plain scrolling reader, exactly as in an Einsatz (`viewer`). A sheet's `row`
 *  and `code` are its name (`planLabel`); a sheet without a module key says its title. */
export function viewerPlanDocs(obj: Pick<StationObject, 'plans' | 'floors'>, gebaeudeLabel: string, catalogue: readonly DeploymentModule[] = []): ViewerPlanDoc[] {
  const seen = new Set<string>()
  const out: ViewerPlanDoc[] = []
  for (const p of obj.plans) {
    let id = planDocId(p)
    for (let n = 2; seen.has(id); n += 1) id = `${planDocId(p)}${n}`
    seen.add(id)
    const title = planTitle(p, catalogue)
    const row = planLabel(planDocId(p), title)
    out.push({
      plan: p,
      row,
      doc: {
        id, code: row, title, subtitle: '', imageUrl: referenceUrl(p.id, p.version), orientation: 'landscape',
        ...(entryFor(catalogue, planDocId(p))?.viewer ? { viewer: true } : {}),
      },
    })
  }
  if (obj.floors.length) {
    out.push({
      plan: null,
      row: gebaeudeLabel,
      doc: { id: GEBAEUDE_DOC, code: gebaeudeLabel, title: gebaeudeLabel, subtitle: '', imageUrl: '', orientation: 'portrait', floorStack: true, icon: 'floors' },
    })
  }
  return out
}
