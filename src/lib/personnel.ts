// Deterministic name resolution for roster-linked people. Display always prefers the
// stored snapshot (so historical Trupps/reports never change when Divera names are later
// edited), falling back to the current roster, then the raw id. Never guessed.

import type { AttendanceState, Person, Trupp } from '../types'
import { rosterNameOrder } from './deploymentConfig'

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

/** personId → the id of the ACTIVE Trupp they are in. Same rule as assignedPersonIds (a Trupp
 *  that is `raus` no longer holds anybody), but it keeps the answer to «which one» — a locked
 *  roster row has to be able to point at the card it is locked by, not just say that it is. */
export function truppByPersonId(trupps: Trupp[]): Map<string, string> {
  const by = new Map<string, string>()
  for (const t of trupps) {
    if (t.status === 'raus') continue
    if (t.leaderPersonId) by.set(t.leaderPersonId, t.id)
    for (const id of t.memberPersonIds ?? []) by.set(id, t.id)
  }
  return by
}

export const presentCount = (attendance: AttendanceState): number =>
  Object.values(attendance).filter((a) => a.status === 'present').length

/** Compact label for a Trupp wherever it is drawn — the plan chip, the map marker, the hose's
 *  end tag: SURNAME first, given name as an initial ("Müller Hans" → "Müller H.").
 *
 *  Surname first because that is how a Feuerwehr calls people and how every list is sorted; the
 *  initial is what fits in a chip. Which TOKEN is the surname depends on the station's name
 *  order (roster.nameOrder): under the default `'last-first'` the given name is the LAST token
 *  and everything before it is the surname, under `'first-last'` it is the other way round.
 *  Either way multi-word Swiss surnames stay intact ("Von Arx Beat" → "Von Arx B."). Reading the
 *  order from config rather than guessing is the whole point — a Divera-synced roster used to
 *  hand this function «Müller Hans» while it assumed «Hans Müller», and the hose tag said
 *  «Hans M.». Single-token or empty strings pass through unchanged. */
export function abbreviateName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2 || !parts[0]) return full.trim()
  const givenIdx = rosterNameOrder() === 'first-last' ? 0 : parts.length - 1
  const given = parts[givenIdx]
  const surname = parts.filter((_, i) => i !== givenIdx).join(' ')
  if (!given || !surname) return full.trim()
  return `${surname} ${given[0].toUpperCase()}.`
}
