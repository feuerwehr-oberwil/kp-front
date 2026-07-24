// Deterministic name resolution for roster-linked people. Display always prefers the
// stored snapshot (so historical Trupps/reports never change when Divera names are later
// edited), falling back to the current roster, then the raw id. Never guessed.

import type { AttendanceState, Person, Trupp } from '../types'

export type Roster = Map<string, Person>

export const rosterFromList = (people: Person[]): Roster => new Map(people.map((p) => [p.id, p]))

/** Resolve one person to a printable name: snapshot → current roster → id (last resort). */
export function resolvePersonName(roster: Roster, id?: string, snapshot?: string): string {
  const snap = snapshot?.trim()
  if (snap) return snap
  if (id) {
    const p = roster.get(id)
    if (p) return p.displayName
  }
  return id ?? ''
}

/** Person ids currently assigned to any non-exited Trupp — used for present-first ordering
 *  and the duplicate-assignment warning in the picker. */
export function assignedPersonIds(trupps: Trupp[]): Set<string> {
  const ids = new Set<string>()
  for (const t of trupps) {
    if (t.status === 'raus') continue
    if (t.leaderPersonId) ids.add(t.leaderPersonId)
    for (const id of t.memberPersonIds ?? []) ids.add(id)
  }
  return ids
}

export const presentCount = (attendance: AttendanceState): number =>
  Object.values(attendance).filter((a) => a.status === 'present').length

/** Compact label for the moving Trupp chip on the plan: full surname + first initial
 *  ("Keller Andreas" → "Keller A."). Names are stored surname-first, so the last token is
 *  the first name. Single-token or empty strings pass through unchanged. */
export function abbreviateName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2 || !parts[parts.length - 1]) return full.trim()
  const surname = parts.slice(0, -1).join(' ')
  return `${surname} ${parts[parts.length - 1][0].toUpperCase()}.`
}
