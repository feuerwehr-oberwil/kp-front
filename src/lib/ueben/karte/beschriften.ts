// «Üben» · Karte 4 – «Leitung beschriften»: the attributes a Leitung carries in an Einsatz – its
// number and its Schlauch (the owner's «all of the attributes we can give», 20.11.2026; coverage =
// what an Einsatz needs). Person, Trupp, Geschoss and Text stand in the same sheet and are named on
// the done card – a typed name is no step «Zeigen» can walk.
//
// Lenient: ANY line with a number / a Schlauch counts; «Zeigen» points at the Leitung to the Eingang.

import { appConfig } from '../../../config/appConfig'
import type { Doc } from '../../workspace'
import type { Drawing } from '../../../types'
import { control, type GoalState, type Hint, type Snapshot, type Step, type UiState } from '../model'
import type { Site } from '../site'
import { hint as drawLeitung } from './leitung'
import { focus, leitungOf, lines, selectLine, toKarte, vehicleAt, withLeitung } from './scene'

const C = () => appConfig.copy.ueben.topics.karte.steps.beschriften

const has = (snap: Snapshot, set: (l: Drawing) => boolean): GoalState => (lines(snap.drawings).some(set) ? { s: 'ok' } : { s: 'open' })
const numbered = (l: Drawing) => l.lineNo != null
const hosed = (l: Drawing) => !!l.hose

/** the Leitung to the Eingang – the one «Zeigen» and «Lösung» work on */
export function theLeitung(snap: Snapshot, site: Site): Drawing | undefined {
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  if (!v || !site.eingang) return undefined
  const { done, joined } = leitungOf(snap, v.e, site.eingang)
  return (done ?? joined)?.l
}

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const away = toKarte(ui)
  if (away) return away
  const l = theLeitung(snap, site)
  if (!l) return drawLeitung(snap, ui, site)
  const h = C().hint
  return selectLine(ui, l) ?? (goal === 0
    // the «+» of the «Leitung Nr.» stepper: the first tap gives number 1
    ? { anchor: control('[data-field="lineNo"] .step-val ~ .step-btn'), words: h.nummer }
    // the «Schlauch» menu: its button, and once it is open its first Ø – the row after «Kein»
    : { anchor: control('.de-menu-pop .de-menu-item:nth-child(2)', '[data-field="hose"] .de-menu-trigger'), words: h.schlauch })
}

function solve(doc: Doc, site: Site, goal: number): Doc {
  const d = withLeitung(doc, site)
  const l = theLeitung(d, site)
  const patch: Partial<Drawing> = goal === 0 ? { lineNo: 1 } : { hose: '40' }
  return l ? { ...d, drawings: d.drawings.map((x) => (x.id === l.id ? { ...x, ...patch } : x)) } : d
}

export const beschriften = {
  id: 'beschriften',
  goals: [{ id: 'nummer', check: (snap) => has(snap, numbered) }, { id: 'schlauch', check: (snap) => has(snap, hosed) }],
  focus,
  hint,
  solve,
  // the start is the Leitung without a number and without a Schlauch
  setup: (doc, site) => {
    const d = withLeitung(doc, site)
    return d.drawings.some((l) => l.kind === 'line' && (numbered(l) || hosed(l)))
      ? { ...d, drawings: d.drawings.map((l) => (l.kind === 'line' && (numbered(l) || hosed(l)) ? { ...l, lineNo: undefined, hose: undefined } : l)) }
      : d
  },
} as const satisfies Step
