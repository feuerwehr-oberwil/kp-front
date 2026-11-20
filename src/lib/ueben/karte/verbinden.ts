// «Üben» · Karte 3 – «Verbinden»: a second Leitung from Hydrant H1 to the Fahrzeug that HANGS on
// both (the magnetic attachment), then the Fahrzeug is moved and its lines come along – the owner's
// «how connections are done» (20.11.2026).
//
// How a Leitung couples (lib/useDraftMagnet): a stroke that STARTS on a symbol hangs on it at once;
// at its END it has to hold still on the symbol until the blue ring is full.

import { appConfig } from '../../../config/appConfig'
import { haversineM } from '../../geo'
import type { Doc } from '../../workspace'
import { control, type GoalState, type Hint, type Snapshot, type Step, type UiState } from '../model'
import { offsetM, type Site } from '../site'
import { hint as placeVehicle } from './fahrzeug'
import { coupled, drawLine, focus, missing, toKarte, vehicleAt, withLeitung, withVehicle, withZubringer, withoutLines, zubringerOf } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.verbinden
/** «moved»: further than a nudge */
const MOVE_M = 5

function checkZubringer(snap: Snapshot, site: Site): GoalState {
  if (!site.h1) return missing(appConfig.copy.ueben.site.hydrant)
  const v = vehicleAt(snap.entities, site.h1)
  if (!v) return { s: 'open' }
  const z = zubringerOf(snap, site.h1, v.e)
  if (z.coupled) return { s: 'ok' }
  return z.loose ? { s: 'wrong', reason: z.loose.free === 'vehicle' ? C().looseVehicle : C().looseH1 } : { s: 'open' }
}

/** how far the Fahrzeug stands from where it stood in `since` */
function movedM(snap: Snapshot, site: Site, since: Snapshot): number {
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  const was = v && since.entities.find((e) => e.id === v.e.id)
  return v && was ? haversineM(was.coord, v.e.coord) : 0
}
const checkMoved = (snap: Snapshot, site: Site, since: Snapshot): GoalState => (movedM(snap, site, since) >= MOVE_M ? { s: 'ok' } : { s: 'open' })

/** where «Zeigen» and «Lösung» move the Fahrzeug: 12 m on, along the street side, clear of the Übungsgebäude */
const movedSpot = (from: [number, number]) => offsetM(from, 10, -6)

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  if (!site.h1) return null
  const h = C().hint
  const v = vehicleAt(snap.entities, site.h1)
  if (!v) return placeVehicle(snap, ui, site)
  if (goal === 0) return drawLine(ui, { kind: 'drag', from: site.h1.coord, to: v.e.coord, hold: true }, h.draw)
  // a selected Leitung shows its points – one sits on the Fahrzeug and would take the drag
  if (ui.selectedDrawingId) return { anchor: control('.ctx .ctx-x'), words: h.close }
  return { anchor: { kind: 'map', at: v.e.coord }, words: h.move, gesture: { kind: 'drag', from: v.e.coord, to: movedSpot(v.e.coord) } }
}

function solve(doc: Doc, site: Site, goal: number): Doc {
  if (goal === 0) return withZubringer(doc, site)
  const v = site.h1 ? vehicleAt(doc.entities, site.h1) : null
  return v ? { ...doc, entities: doc.entities.map((e) => (e.id === v.e.id ? { ...e, coord: movedSpot(e.coord) } : e)) } : doc
}

export const verbinden = {
  id: 'verbinden',
  goals: [{ id: 'zubringer', check: checkZubringer }, { id: 'mitziehen', check: checkMoved }],
  focus,
  hint,
  solve,
  // the start is the Fahrzeug – beside H1, not on it – with its Leitung: a line on both H1 and the Fahrzeug leaves
  setup: (doc, site) => {
    const d = withLeitung(withVehicle(doc, site, true), site)
    const h1 = site.h1
    const v = h1 ? vehicleAt(d.entities, h1) : null
    return h1 && v ? withoutLines(d, (l) => [h1, v.e].every((t) => coupled(l, 'start', t) || coupled(l, 'end', t))) : d
  },
} as const satisfies Step
