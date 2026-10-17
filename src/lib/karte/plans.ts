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
import { moduleTileLabel } from '../navRail'
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
 * The words a plan's TITLE says — the tablet rail's labels and the view label (owner, 17.10.2026 · R2;
 * the sheet's rows say only the module since round 4, `planRowLabel`). The station's pull titles many sheets
 * «<object> – <module key>» — the file name, which only repeats the object the sheet already
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
  if (!word) return moduleTileLabel(id)
  // a numbered sibling (`modul5-wasser2`) is a second sheet of its slot, never a copy of the name
  const n = entry!.id !== id ? /(\d+)$/.exec(id)?.[1] : undefined
  return n ? `${word} ${n}` : word
}

/**
 * The words a plan ROW says in the object's sheet (owner, review round 4, 17.10.2026: «just
 * "modul 1", "modul 2", etc. is enough»): the module key, spoken — nothing else. No title, no
 * «PDF · 1 Seite», no number badge. «modul1» → «Modul 1», «modul2-3» (or «modul23») → «Modul 2-3»,
 * «modul5-pv» → «Modul 5-PV», «modul5-wasser1» → «Modul 5-Wasser 1», «modul5-pv15» → «Modul 5-PV 15».
 * A sub-slot word of up to three letters is an abbreviation (PV, RWA, AEH) and is upper-cased,
 * a longer one is a word (Wasser, Evak, Adressen) — the rule the rail's tiles use
 * (lib/navRail · moduleTileLabel). A key that is no module key at all says the plan's title
 * (`planTitle`). `word` is the copy's «Modul {m}». Pure.
 */
export function planRowLabel(
  p: Pick<StationPlan, 'module' | 'id' | 'title'>,
  catalogue: readonly DeploymentModule[] = [],
  word = 'Modul {m}',
): string {
  const key = planDocId(p)
  const say = (m: string) => word.replace('{m}', m)
  const range = /^modul(\d+)-(\d+)$/.exec(key)
  if (range) return say(`${range[1]}-${range[2]}`)
  const sub = /^modul(\d+)-([a-z]+)(\d*)$/i.exec(key)
  if (sub) {
    const w = sub[2]
    const cased = w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()
    return say(`${sub[1]}-${cased}${sub[3] ? ` ${sub[3]}` : ''}`)
  }
  const single = /^modul(\d+)$/.exec(key)
  if (single) return say(single[1])
  return planTitle(p, catalogue)
}

/** `row`: the words its row in the object's sheet says (`planRowLabel`; «Gebäude» for the stack) */
export interface ViewerPlanDoc { doc: PlanDocument; plan: StationPlan | null; row: string }

/** The object's documents in rail order — its plans by module, then the Gebäude stack when the
 *  station prepared floors. `gebaeudeLabel` is the copy word for that tile; `catalogue` (the
 *  deployment's modules, lib/planOrder · moduleCatalogue) names each sheet (`planTitle`) and says
 *  which open in the plain scrolling reader, exactly as in an Einsatz (`viewer`). `rowWord` is the
 *  copy's «Modul {m}» for the sheet's rows (`planRowLabel`). */
export function viewerPlanDocs(obj: Pick<StationObject, 'plans' | 'floors'>, gebaeudeLabel: string, catalogue: readonly DeploymentModule[] = [], rowWord?: string): ViewerPlanDoc[] {
  const seen = new Set<string>()
  const out: ViewerPlanDoc[] = []
  for (const p of obj.plans) {
    let id = planDocId(p)
    for (let n = 2; seen.has(id); n += 1) id = `${planDocId(p)}${n}`
    seen.add(id)
    out.push({
      plan: p,
      row: planRowLabel(p, catalogue, rowWord),
      doc: {
        id, code: p.code, title: planTitle(p, catalogue), subtitle: '', imageUrl: referenceUrl(p.id, p.version), orientation: 'landscape',
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
