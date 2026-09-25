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

export interface CrewToFile {
  truppId: string
  /** the «Unter AS: …» / «Im Trupp: …» template and the role word it takes */
  groupTemplate: string
  role: string
  /** the Verlauf row's derived id */
  rowId: string
  entries: { id: string; name: string; note: string }[]
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
    const entries: CrewToFile['entries'] = []
    const seen = new Set<string>()
    for (const sl of slots) {
      const name = (sl.name ?? '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const known = sl.id ?? resolve(name)
      if (known) {
        if (!attendance[known]) entries.push({ id: known, name, note: sl.note })
        continue
      }
      if (namesOnList.has(name)) continue
      const id = derivedCrewGuestId(t.id, name)
      if (!attendance[id]) entries.push({ id, name, note: sl.note })
    }
    if (entries.length) {
      out.push({ truppId: t.id, groupTemplate, role, rowId: `atc-${t.id}-${shortHash(entries.map((e) => e.id).sort().join('|'))}`, entries })
    }
  }
  return out
}
