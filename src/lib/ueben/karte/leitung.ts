// «Üben» · Karte 2 – «Leitung mit Pfeil»: a Leitung WITH ITS ARROW from the Fahrzeug to the
// Eingang. The arrow is checked (owner, 19.11.2026) – it is what says where the water flows. It is
// the line's `arrow` at its LAST point (types · Drawing.arrow), so the line must run Fahrzeug →
// Eingang with `arrow` on; drawn the other way round, «Richtung umkehren» turns it.

import { appConfig } from '../../../config/appConfig'
import { fillTemplate } from '../../format'
import { control, type GoalState, type Hint, type Snapshot, type Step, type UiState } from '../model'
import type { Site } from '../site'
import { hint as placeVehicle } from './fahrzeug'
import { besideH1, drawLine, END_AT_M, focus, hasArrow, joins, leitungOf, lineMiss, lines, missing, selectLine, toKarte, vehicleAt, withLeitung, withVehicle, withoutLines } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.leitung

function check(snap: Snapshot, site: Site): GoalState {
  const eingang = site.eingang
  if (!eingang) return missing(appConfig.copy.ueben.site.eingang)
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  if (!v) return { s: 'open' }
  const { done, joined, last } = leitungOf(snap, v.e, eingang)
  if (done) return { s: 'ok' }
  if (joined) return { s: 'wrong', reason: hasArrow(joined.l) ? C().arrowBack : C().noArrow }
  if (!last) return { s: 'open' }
  if (last.x.atA > END_AT_M) return { s: 'wrong', reason: fillTemplate(C().startFar, { m: Math.round(last.x.atA) }) }
  return { s: 'wrong', reason: fillTemplate(C().endFar, { m: Math.round(last.x.atB) }) }
}

export function hint(snap: Snapshot, ui: UiState, site: Site): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  if (!site.h1 || !site.eingang) return null
  const h = C().hint
  const v = vehicleAt(snap.entities, site.h1)
  if (!v) return placeVehicle(snap, ui, site)
  // a Leitung that joins the two but lacks its arrow, or runs the wrong way: its editor's controls
  const joined = leitungOf(snap, v.e, site.eingang).joined
  if (joined) {
    return selectLine(ui, joined.l) ?? (hasArrow(joined.l)
      ? { anchor: control('[data-field="lineReverse"] button'), words: h.reverse }
      : { anchor: control('[data-field="lineEnd"] [data-value="arrow"]'), words: h.arrow })
  }
  const from = v.e.coord ?? besideH1(site.h1.coord)
  return drawLine(ui, { kind: 'drag', from, to: site.eingang.coord }, lines(snap.drawings).length ? h.fix : h.draw)
}

export const leitung = {
  id: 'leitung',
  goals: [{ id: 'leitung', check }],
  focus,
  hint,
  solve: (doc, site) => withLeitung(doc, site),
  // the start is the Fahrzeug alone: a Leitung that joins it and the Eingang leaves
  setup: (doc, site) => {
    const d = withVehicle(doc, site)
    const v = site.h1 ? vehicleAt(d.entities, site.h1) : null
    const eingang = site.eingang
    return v && eingang ? withoutLines(d, (l) => l.coords.length >= 2 && joins(lineMiss(l, v.e, eingang))) : d
  },
} as const satisfies Step
