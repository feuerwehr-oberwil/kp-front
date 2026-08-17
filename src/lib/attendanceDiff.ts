import type { AttendanceState, Person } from '../types'

/**
 * Who moved between two states of the Anwesenheit.
 *
 * The undo stack holds whole-list snapshots (see useUndoableSlice), which is right for stepping
 * but says nothing a reader can use. The Verlauf needs the one fact the step is about: WHOSE row
 * changed. «Anwesenheit zurückgenommen: Hofer Simon» is a correction somebody can check; a bare
 * «zurückgenommen» is a line that has to be reconstructed from the rows around it.
 *
 * Names come from the roster first and from the entry's own snapshot second — a guest has no
 * roster row, and a removed entry only exists on the side it was removed from.
 */
export function changedAttendanceNames(
  from: AttendanceState,
  to: AttendanceState,
  roster: Map<string, Person>,
): string[] {
  const names: string[] = []
  for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = from[id]
    const b = to[id]
    // identity first: every write copies the map and replaces exactly the entries it touches, so
    // an untouched person is the SAME object on both sides. The value compare is the safety net
    // for a snapshot that came in through another path.
    if (a === b || (a && b && JSON.stringify(a) === JSON.stringify(b))) continue
    names.push(roster.get(id)?.displayName ?? b?.displayNameSnapshot ?? a?.displayNameSnapshot ?? id)
  }
  return names.sort((x, y) => x.localeCompare(y, 'de'))
}
