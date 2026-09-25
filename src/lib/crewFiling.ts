import type { AttendanceState, Trupp } from '../types'
import { truppRoleNote } from './roleAssignment'

/**
 * The crew of a Trupp that the Anwesenheit has not heard of yet — what an editor device files on
 * OBSERVING it (staging walk-through 25.09.2026, N2).
 *
 * A Trupp registered on the Atemschutz-Link never reached the Anwesenheit: the link may write the
 * Trupps and nothing else (backend · auth/incident_link.py), so the crew it typed in — Gäste above
 * all, who have no roster id — stood under breathing apparatus with no row on the personnel
 * record, and the Verlauf even claimed «… als weitere Person erfasst». Now the link writes no such
 * row, and every device that MAY write the record reads the Trupps and files what is missing.
 *
 * ⚠️ An observed fact is filed under an id every device computes identically (AGENTS.md · «what
 * every device OBSERVES is recorded under a DERIVED id, once»): a roster person under their own
 * id, a Gast under `g-<truppId>-<hash of the name>`, and the one Verlauf row per Trupp under
 * `atc-<truppId>-<hash of the ids>` — so two tablets observing the same Link write converge on one
 * row per person and one line in the Verlauf. Nobody is filed twice: a person already on the
 * Anwesenheit (by id, or — a Gast typed on an editor device — by the same name) is left alone,
 * and so is anybody who has ever been on it, even if they left since.
 *
 * ⚠️ And it is a ONE-SHOT per (Trupp, person), not a reconciliation (staging r2 review): the
 * Trupp carries `crewFiled`, the keys of everybody the Anwesenheit has already been told about —
 * filed here, or found already there when the Trupp was seen. A key on it is never filed again,
 * so somebody taking a crew member OFF the Anwesenheit is a decision no device writes back. Built
 * like the ghost trails (AGENTS.md): derived keys, and the marker merges as a union
 * (mergeWorkspace · mergeTrupp), so two devices stamping the same crew converge.
 */

/** FNV-1a, base 36 — only has to tell two inputs apart, never to be read */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}

/** The id an observed Gast of this Trupp is filed under — the same on every device. */
export function derivedCrewGuestId(truppId: string, name: string): string {
  return `g-${truppId}-${shortHash(name.trim())}`
}

/** The `crewFiled` keys a Trupp carries — defensive: a stray value is read as nothing. */
export function crewFiledOf(t: Pick<Trupp, 'crewFiled'> | undefined): string[] {
  const v = (t as { crewFiled?: unknown } | undefined)?.crewFiled
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
}

/** The union of two markers, sorted — the one shape every device writes, so equal sets compare
 *  equal and a merge sees no divergence where there is none. `undefined` when empty. */
export function unionCrewFiled(...sides: (readonly string[] | undefined)[]): string[] | undefined {
  const all = [...new Set(sides.flatMap((s) => (Array.isArray(s) ? s.filter((x) => typeof x === 'string' && x !== '') : [])))].sort()
  return all.length ? all : undefined
}

/** A restored Trupp (an undo) keeps the marker the live one carries — the marker is a machine
 *  fact about the Anwesenheit, not part of the edit being taken back; dropping keys from it would
 *  re-arm the filing for people somebody may have deliberately taken off the list since. */
export function keepCrewFiled<T extends Pick<Trupp, 'crewFiled'>>(restored: T, live: Pick<Trupp, 'crewFiled'> | undefined): T {
  const merged = unionCrewFiled(crewFiledOf(restored), crewFiledOf(live))
  if (!merged) return restored
  return { ...restored, crewFiled: merged }
}

export interface CrewToFile {
  truppId: string
  /** the «Unter AS: …» / «Im Trupp: …» template and the role word it takes */
  groupTemplate: string
  role: string
  /** the Verlauf row's derived id */
  rowId: string
  entries: { id: string; name: string; note: string }[]
  /** the keys to add to the Trupp's `crewFiled` — those filed now AND those found already on the
   *  Anwesenheit — so nobody of this crew is ever filed by a device again */
  mark: string[]
}

export function unfiledTruppCrew(
  trupps: readonly Trupp[],
  attendance: AttendanceState,
  /** a typed name → the roster person it is, if any */
  resolve: (name: string) => string | undefined,
): CrewToFile[] {
  const namesOnList = new Set(Object.values(attendance).map((a) => (a.displayNameSnapshot ?? '').trim()).filter(Boolean))
  const out: CrewToFile[] = []
  for (const t of trupps) {
    if (t.removedAt) continue
    const { role, leaderRole, groupTemplate } = truppRoleNote(t)
    const members = t.members ?? []
    // the ids are index-aligned with the names only when both lists are whole (lib/personnel ·
    // truppSlots); otherwise a member is resolved by name
    const aligned = (t.memberPersonIds?.length ?? -1) === members.length
    const slots = [
      { name: t.name, id: t.leaderPersonId, note: leaderRole },
      ...members.map((name, i) => ({ name, id: aligned ? t.memberPersonIds![i] : undefined, note: role })),
    ]
    const filed = new Set(crewFiledOf(t))
    const entries: CrewToFile['entries'] = []
    const mark: string[] = []
    const seen = new Set<string>()
    for (const sl of slots) {
      const name = (sl.name ?? '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const known = sl.id ?? resolve(name)
      // the key is the id the person IS filed under when this code files them
      const key = known ?? derivedCrewGuestId(t.id, name)
      if (filed.has(key)) continue // told once — whatever became of that entry is a person's call
      mark.push(key)
      const onList = known ? !!attendance[known] : namesOnList.has(name) || !!attendance[key]
      if (!onList) entries.push({ id: key, name, note: sl.note })
    }
    if (mark.length) {
      out.push({
        truppId: t.id, groupTemplate, role,
        rowId: `atc-${t.id}-${shortHash(entries.map((e) => e.id).sort().join('|'))}`,
        entries, mark,
      })
    }
  }
  return out
}

/** The Trupps with this pass's keys stamped on their `crewFiled` — the SAME array back when there
 *  is nothing new, so the machine writer writes nothing when nothing changed. */
export function stampCrewFiled<T extends Pick<Trupp, 'id' | 'crewFiled'>>(trupps: T[], todo: readonly CrewToFile[]): T[] {
  const marks = new Map(todo.map((f) => [f.truppId, f.mark]))
  let changed = false
  const next = trupps.map((t) => {
    const add = marks.get(t.id)
    if (!add?.length) return t
    const before = crewFiledOf(t)
    const merged = unionCrewFiled(before, add)!
    if (merged.length === before.length && merged.every((k, i) => k === before[i])) return t
    changed = true
    return { ...t, crewFiled: merged }
  })
  return changed ? next : trupps
}
