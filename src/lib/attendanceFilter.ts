// How the crew list narrows — the predicates behind the Anwesenheit's two filter buttons.
// Here rather than inside the view so they can be tested without mounting a surface, and
// beside the other attendance readers (attendanceIntervals · attendanceOrt) that they use.

import { isPresent } from './attendanceIntervals'
import { ortOf } from './attendanceOrt'
import type { AttendanceEntry } from '../types'

/** One state a person can be filtered to.
 *
 * ⚠️ Ort is not a facet of its own: only somebody who is HERE can be «Vor Ort» or «im Magazin»,
 * so the two places are refinements of «anwesend», not an independent axis. As a separate group
 * they could be combined into a contradiction («nicht anwesend» + «Magazin») whose only honest
 * answer is an empty list — a filter that can be set to return nothing is a filter that will be.
 * One list; the two places sit under the state they belong to.
 *
 * Every value reads off the same `attendance` entry the row's own marks do, so a filtered list
 * can never disagree with the marks that named it. */
export type StateKey = 'frei' | 'present' | 'left' | 'scene' | 'station'

export function stateMatches(f: StateKey, a: AttendanceEntry | undefined): boolean {
  const present = isPresent(a)
  switch (f) {
    case 'frei': return !a
    case 'present': return present
    case 'left': return !!a && !present
    case 'scene': return present && ortOf(a) !== 'station'
    case 'station': return present && ortOf(a) === 'station'
  }
}

/** Several picks inside ONE facet are an OR — «anwesend oder gegangen» is «wer war überhaupt
 *  da». ⚠️ An empty set is «alle», not «keine»: a filter nobody has touched must not hide the
 *  list it sits above. (Facets AND with each other — see AnwesenheitView · rows.) */
export function matchesAny<T>(sel: ReadonlySet<T>, test: (v: T) => boolean): boolean {
  if (sel.size === 0) return true
  for (const v of sel) if (test(v)) return true
  return false
}

/** Flip one value in a selection set (immutably — the state IS the set). */
export function toggled<T>(sel: ReadonlySet<T>, v: T): Set<T> {
  const next = new Set(sel)
  if (!next.delete(v)) next.add(v)
  return next
}
