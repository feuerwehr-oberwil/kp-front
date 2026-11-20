// «Üben» · Karte 1 – «Fahrzeug setzen»: a Fahrzeug by Hydrant H1 (the owner's own example,
// 19.11.2026: «place a vehicle with a hose attached»). Lenient: any placed Fahrzeug near H1.

import { appConfig } from '../../../config/appConfig'
import { fillTemplate } from '../../format'
import { haversineM } from '../../geo'
import { control, type GoalState, type Hint, type Snapshot, type Step, type UiState } from '../model'
import type { Site } from '../site'
import { ADD_TILE, besideH1, END_AT_M, focus, isVehicle, missing, NEAR_M, toKarte, vehicleAt, vehicleName, withVehicle, withoutLines } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.fahrzeug

function check(snap: Snapshot, site: Site): GoalState {
  if (!site.h1) return missing(appConfig.copy.ueben.site.hydrant)
  const v = vehicleAt(snap.entities, site.h1)
  if (!v) return { s: 'open' }
  return v.d <= NEAR_M ? { s: 'ok' } : { s: 'wrong', reason: fillTemplate(C().far, { m: Math.round(v.d) }) }
}

export function hint(snap: Snapshot, ui: UiState, site: Site): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  if (!site.h1) return null
  const h = C().hint
  const spot = besideH1(site.h1.coord)
  const v = vehicleAt(snap.entities, site.h1)
  if (v) return { anchor: { kind: 'map', at: v.e.coord }, words: h.drag, gesture: { kind: 'drag', from: v.e.coord, to: spot } }
  if (ui.tool === 'symbol' && ui.pending === vehicleName()) return { anchor: { kind: 'map', at: spot }, words: h.tapBeside, gesture: { kind: 'tap', at: spot } }
  if (ui.paletteOpen) return { anchor: control(`[data-sym="${vehicleName()}"]`), words: h.pick }
  return { anchor: control(ADD_TILE), words: ui.phone ? h.addPhone : h.addTablet, gesture: { kind: 'tap', at: spot } }
}

export const fahrzeug = {
  id: 'fahrzeug',
  goals: [{ id: 'fahrzeug', check }],
  focus,
  hint,
  solve: (doc, site) => withVehicle(doc, site),
  // the start is the empty site: every placed Fahrzeug and every Leitung touching one leave
  setup: (doc) => {
    const gone = doc.entities.filter(isVehicle)
    if (!gone.length) return doc
    const ids = new Set(gone.map((e) => e.id))
    const touches = (l: (typeof doc.drawings)[number]) =>
      [l.startAttachment, l.endAttachment].some((a) => a?.target.kind === 'object' && ids.has(a.target.id))
      || gone.some((e) => haversineM(l.coords[0], e.coord) <= END_AT_M || haversineM(l.coords[l.coords.length - 1], e.coord) <= END_AT_M)
    return withoutLines({ ...doc, entities: doc.entities.filter((e) => !ids.has(e.id)) }, touches)
  },
} as const satisfies Step
