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

/** One name reduced to what it MEANS for matching: trimmed, case-folded, whitespace collapsed. */
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

/** …and the same name with its words put in a fixed order, so «Hans Müller» and «Müller Hans»
 *  reduce to one key. Alphabetical rather than "surname first" on purpose: which token IS the
 *  surname is exactly what a name typed in the other order does not tell us. */
const swappedKey = (name: string) => nameKey(name).split(' ').sort().join(' ')

/**
 * A name → roster id index, matched the way people actually retype a name: trimmed, case-folded
 * — and TOLERANT OF THE WORD ORDER.
 *
 * ⚠️ The order tolerance is the point. The station has one name order (roster.nameOrder, served
 * by the backend), but an operator typing at 3am has their own, and half of them write «Hans
 * Müller» where the roster says «Müller Hans». That used to resolve to nobody, which is not a
 * cosmetic difference — it made the typed name a GUEST: no id, so the Anwesenheit row never
 * locked, the picker went on offering somebody already under Atemschutz, the Verlauf stopped
 * marking their name, and `abbreviateName` — which reads the station order to decide which token
 * is the surname — turned them into «Peter S.» beside a «Müller H.» on the same Kroki. One
 * roster person, two spellings, and every downstream feature quietly off.
 *
 * The exact spelling always wins: a swapped key is only added where nothing claims it, and an
 * ambiguous one (two people who are each other's reversal) is dropped rather than guessed —
 * picking the wrong one would put the wrong person on an Atemschutz record.
 */
export function rosterIdByName(people: Person[]): Map<string, string> {
  const active = people.filter((p) => p.active)
  const out = new Map(active.map((p) => [nameKey(p.displayName), p.id]))
  const swapped = new Map<string, string | null>()
  for (const p of active) {
    const k = swappedKey(p.displayName)
    if (!k || out.has(k)) continue
    swapped.set(k, swapped.has(k) ? null : p.id)
  }
  for (const [k, id] of swapped) if (id) out.set(k, id)
  return out
}

/** Look a name up in a `rosterIdByName` index — the exact spelling first, then the word order
 *  the operator happened to use. Every caller goes through this, so «matches the roster» means
 *  one thing app-wide instead of five `.get(name.toLowerCase())` calls that each decide. */
export function personIdForName(byName: Map<string, string>, name: string | undefined): string | undefined {
  const n = (name ?? '').trim()
  if (!n) return undefined
  return byName.get(nameKey(n)) ?? byName.get(swappedKey(n))
}

/** The roster's own spelling of a name, if it names somebody on it — «Hans Müller» → «Müller
 *  Hans». Everything drawn from a name (the Trupp card, the hose tag, `abbreviateName`, the bold
 *  in the Verlauf) reads better from ONE spelling, and the roster's is the one the rest of the
 *  app already uses. Unknown names — real Gäste, mutual aid — pass through untouched. */
export function canonicalName(name: string, byName: Map<string, string>, roster: Roster): string {
  const id = personIdForName(byName, name)
  return (id && roster.get(id)?.displayName?.trim()) || name
}

/**
 * A Trupp as the FORM reads it: one slot per person, leader first, each carrying the roster id
 * behind their name where there is one.
 *
 * Two shapes have to survive this, and the stored record cannot distinguish them:
 *
 *  · **No ids at all.** Not only ancient records — a device offline through a roster sync, a
 *    workspace written by an older build, a draft kept in the browser from before ids existed.
 *    Everything downstream then treats those people as guests: the form badges all three «Gast»,
 *    the picker goes on offering somebody already committed, and «einer, ein Trupp» stops
 *    holding — with the roster row sitting right there under the same name.
 *
 *  · **⚠️ A COMPACTED id array.** `memberPersonIds` is written `.filter(Boolean)` (submitForm) but
 *    read positionally, so a Trupp of [Gast, Meier] stores `[meierId]` — and on reopen slot 0,
 *    the Gast, adopts Meier's id. That is a wrong PERSON on an Atemschutz record, and it is
 *    silent. So a positional id is trusted only when the roster agrees it belongs to that name;
 *    otherwise the name decides.
 *
 * A name matching nobody keeps no id: that is a real Gast, and inventing a roster row for them
 * would be the same class of error in the other direction.
 */
export function truppSlots(t: Trupp, byName: Map<string, string>, roster: Roster): { name: string; personId?: string }[] {
  const idOf = (name: string) => personIdForName(byName, name)
  // «the stored id belongs to this name» — word-order tolerant like the lookup above, or a Trupp
  // typed «Hans Müller» would keep failing this check and fall back to the name every time
  const same = (id: string | undefined, name: string) =>
    !!id && swappedKey(roster.get(id)?.displayName ?? '') === swappedKey(name)
  const resolve = (name: string, stored?: string) => (same(stored, name) ? stored : idOf(name) ?? (stored && !roster.has(stored) ? stored : undefined))
  const out: { name: string; personId?: string }[] = []
  if (t.name?.trim()) out.push({ name: t.name, personId: resolve(t.name, t.leaderPersonId) })
  const ids = t.memberPersonIds ?? []
  ;(t.members ?? []).forEach((m, i) => {
    if (m?.trim()) out.push({ name: m, personId: resolve(m, ids[i]) })
  })
  return out
}

/**
 * The Trupps as the rest of the app should READ them: every member who resolves to a roster row
 * carrying that row's id.
 *
 * A read-only projection — nothing here rewrites the record. It exists because the three answers
 * everything else asks (`assignedPersonIds`, `truppByPersonId`, `personStatusHint`) are computed
 * from ids alone, so a Trupp holding only NAMES was invisible to all of them: the Fahrer picker
 * said nothing about somebody already under Atemschutz, the Anwesenheit row did not lock, and
 * «einer, ein Trupp» silently stopped holding. Resolving once, here, is what keeps those three
 * from each needing their own name fallback.
 */
export function linkTrupps(trupps: Trupp[], byName: Map<string, string>, roster: Roster): Trupp[] {
  if (byName.size === 0) return trupps
  let changed = false
  const out = trupps.map((t) => {
    const slots = truppSlots(t, byName, roster)
    const ids = slots.map((sl) => sl.personId).filter(Boolean) as string[]
    const leaderPersonId = slots[0]?.personId
    const memberIds = slots.slice(1).map((sl) => sl.personId).filter(Boolean) as string[]
    const before = [t.leaderPersonId, ...(t.memberPersonIds ?? [])].filter(Boolean)
    if (leaderPersonId === t.leaderPersonId && before.length === ids.length) return t
    changed = true
    return { ...t, leaderPersonId, memberPersonIds: memberIds }
  })
  return changed ? out : trupps
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
