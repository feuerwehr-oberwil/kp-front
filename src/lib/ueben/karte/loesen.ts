// «Üben» · Karte 6 – «Lösen und löschen»: a Leitung is let go of its Fahrzeug («Verbindung
// lösen»), removed, and brought back with «Rückgängig». All three goals are CHANGES against
// `since` (lib/ueben/model). Lenient: any line counts; «Zeigen» works on the Zubringer.

import { appConfig } from '../../../config/appConfig'
import type { Doc } from '../../workspace'
import type { Drawing } from '../../../types'
import { control, type GoalState, type Hint, type Snapshot, type Step, type UiState } from '../model'
import type { Site } from '../site'
import { coupled, focus, lines, selectLine, toKarte, vehicleAt, withZubringer, zubringerOf } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.loesen

const state = (ok: boolean): GoalState => (ok ? { s: 'ok' } : { s: 'open' })
const byId = (snap: Snapshot) => new Map(lines(snap.drawings).map((l) => [l.id, l]))

/** a line that hung on something in `since` and still exists has an end free now */
function checkFreed(snap: Snapshot, _site: Site, since: Snapshot): GoalState {
  const was = byId(since)
  return state(lines(snap.drawings).some((l) => {
    const w = was.get(l.id)
    return !!w && ((!!w.startAttachment && !l.startAttachment) || (!!w.endAttachment && !l.endAttachment))
  }))
}
const checkGone = (snap: Snapshot, _site: Site, since: Snapshot) => state(lines(since.drawings).some((w) => !byId(snap).has(w.id)))
const checkBack = (snap: Snapshot, _site: Site, since: Snapshot) => state(lines(snap.drawings).some((l) => !byId(since).has(l.id)))

/** the line «Zeigen» and «Lösung» work on: the selected one, else the Zubringer, else the last line */
function target(snap: Snapshot, ui: Pick<UiState, 'selectedDrawingId'>, site: Site): Drawing | undefined {
  const ls = lines(snap.drawings)
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  const z = site.h1 && v ? zubringerOf(snap, site.h1, v.e) : {}
  return ls.find((l) => l.id === ui.selectedDrawingId) ?? z.coupled ?? z.loose?.l ?? ls[ls.length - 1]
}

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  const h = C().hint
  if (goal === 2) return { anchor: control('.tb-act-history:not(.tb-act-redo)'), words: h.undo }
  const l = target(snap, ui, site)
  if (!l) return null
  return selectLine(ui, l) ?? (goal === 0
    ? { anchor: control('[data-field="detach"] button'), words: h.detach }
    : { anchor: control('[data-field="delete"]'), words: h.remove })
}

function solve(doc: Doc, site: Site, goal: number): Doc {
  if (goal === 2) return withZubringer(doc, site)
  const d = goal === 0 ? withZubringer(doc, site) : doc
  const l = target(d, { selectedDrawingId: null }, site)
  if (!l) return d
  if (goal === 1) return { ...d, drawings: d.drawings.filter((x) => x.id !== l.id) }
  // the end on the Fahrzeug lets go; the point stays where it is
  const v = site.h1 ? vehicleAt(d.entities, site.h1) : null
  const end = v && coupled(l, 'start', v.e) ? 'startAttachment' : 'endAttachment'
  return { ...d, drawings: d.drawings.map((x) => (x.id === l.id ? { ...x, [end]: undefined } : x)) }
}

export const loesen = {
  id: 'loesen',
  goals: [{ id: 'geloest', check: checkFreed }, { id: 'geloescht', check: checkGone }, { id: 'zurueck', check: checkBack }],
  focus,
  hint,
  solve,
  setup: (doc, site) => withZubringer(doc, site),
} as const satisfies Step
