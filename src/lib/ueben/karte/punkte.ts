// «Üben» · Karte 5 – «Punkte»: a Leitung is led round an obstacle by its points – «+» between two
// points inserts one, a point held until its ring is full goes (the owner's «how to delete a
// section of the node», 20.11.2026). Both goals are CHANGES: they compare the line's points with
// `since` (lib/ueben/model).

import { appConfig } from '../../../config/appConfig'
import { haversineM, midCoord } from '../../geo'
import type { Doc } from '../../workspace'
import type { Drawing, LngLat } from '../../../types'
import type { GoalState, Hint, Snapshot, Step, UiState } from '../model'
import { offsetM, type Site } from '../site'
import { theLeitung } from './beschriften'
import { hint as drawLeitung } from './leitung'
import { focus, lines, selectLine, toKarte, withLeitung } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.punkte

/** does some line have more (`by` 1) or fewer (`by` -1) points than it had in `since`? */
function pointsChanged(snap: Snapshot, since: Snapshot, by: 1 | -1): GoalState {
  const was = new Map(since.drawings.map((d) => [d.id, d.coords.length]))
  const changed = lines(snap.drawings).some((l) => {
    const n = was.get(l.id)
    return n != null && Math.sign(l.coords.length - n) === by
  })
  return changed ? { s: 'ok' } : { s: 'open' }
}

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  const l = theLeitung(snap, site)
  if (!l) return drawLeitung(snap, ui, site)
  const h = C().hint
  return selectLine(ui, l) ?? (goal === 0
    ? { anchor: { kind: 'control', sel: ['.measure-insert'], at: l.coords }, words: h.plus }
    : { anchor: { kind: 'control', sel: ['.draw-handle[data-node="inner"]'], hold: true, at: l.coords }, words: h.hold })
}

/** `l` with one more point: the middle of its longest piece, 6 m to the side */
function withPoint(l: Drawing): Drawing {
  const i = l.coords.slice(1).reduce((best, c, j) => (haversineM(l.coords[j], c) > haversineM(l.coords[best], l.coords[best + 1]) ? j : best), 0)
  const mid: LngLat = offsetM(midCoord(l.coords[i], l.coords[i + 1]), 6, 0)
  return { ...l, coords: [...l.coords.slice(0, i + 1), mid, ...l.coords.slice(i + 1)] }
}

function solve(doc: Doc, site: Site, goal: number): Doc {
  const d = withLeitung(doc, site)
  const l = theLeitung(d, site)
  if (!l) return d
  if (goal === 1 && l.coords.length < 3) return d
  const next = goal === 0 ? withPoint(l) : { ...l, coords: [l.coords[0], ...l.coords.slice(2)] }
  return { ...d, drawings: d.drawings.map((x) => (x.id === l.id ? next : x)) }
}

export const punkte = {
  id: 'punkte',
  goals: [{ id: 'einfuegen', check: (snap, _site, since) => pointsChanged(snap, since, 1) }, { id: 'entfernen', check: (snap, _site, since) => pointsChanged(snap, since, -1) }],
  focus,
  hint,
  solve,
  setup: (doc, site) => withLeitung(doc, site),
} as const satisfies Step
