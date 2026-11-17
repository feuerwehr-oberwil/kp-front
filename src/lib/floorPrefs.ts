// Which storeys of the Gebäude stack THIS DEVICE is looking at, per incident.
//
// Hiding a Geschoss is a way of LOOKING at the building, not a fact about it (16.09.2026): the
// EL reading the 1. OG on a phone wants the other three storeys out of the way, the Kommandotisch
// wants the whole section — and neither may decide that for the other. So it never reaches the
// synced workspace: the storey keeps its ink, the Karte keeps showing it, and the Rapport prints
// the full stack whatever this device has folded away. Same reasoning, same shape and the same
// best-effort storage as lib/layerPrefs (lib/incidentPrefStore).
//
// Stored as the HIDDEN set rather than the visible one, because that is the value that survives a
// pack gaining a storey: a floor nobody has hidden is shown, including one that did not exist when
// the device last looked.

import { incidentPrefStore } from './incidentPrefStore'

const store = incidentPrefStore<number[]>({
  key: (incidentId) => `kp.floors.hidden.${incidentId}`,
  parse: (v) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : undefined),
})

/** The storeys this device has folded away on this incident. Empty = the whole stack. */
export const loadHiddenFloors = (incidentId: string): number[] => store.read(incidentId) ?? []

/** Remember what this device has folded away. Never reaches the server. */
export function saveHiddenFloors(incidentId: string, floors: readonly number[]): void {
  if (floors.length) store.write(incidentId, floors)
  else store.clear(incidentId) // «alles sichtbar» is the default, not a stored state
}

/** What is left to draw. ⚠️ Never empty: hiding the last visible storey would leave a board with
 *  no tiles and no way back to one, so the request is ignored and the whole stack stays. */
export const shownFloors = (all: readonly number[], hidden: readonly number[]): number[] => {
  const out = all.filter((f) => !hidden.includes(f))
  return out.length ? out : [...all]
}

/** A Trupp chip on the stack, as the folded strip and the unfold rule read it. `tone` is its alarm
 *  tier (lib/truppLines · truppMarkerTone): `crit` = überfällig or Notfall, `warn` = fällig. */
export interface StoreyTeam { id: string; floor: number; name: string; color?: string; tone: 'warn' | 'crit' | null }

const RANK = { crit: 2, warn: 1 } as const
const rank = (t: StoreyTeam) => (t.tone ? RANK[t.tone] : 0)

/** The Trupps standing on each folded storey, the one in most trouble first – what the strip's
 *  chip shows (rare-user round 17.11.2026, M7 = B: «Müller H. +1»). Storeys with nobody on them
 *  are absent. Stable within a tier, so the chip does not hop between two quiet Trupps. */
export function foldedStoreyTeams(teams: readonly StoreyTeam[], hidden: readonly number[]): Map<number, StoreyTeam[]> {
  const out = new Map<number, StoreyTeam[]>()
  for (const t of teams) {
    if (!hidden.includes(t.floor)) continue
    out.set(t.floor, [...(out.get(t.floor) ?? []), t])
  }
  for (const [f, list] of out) out.set(f, [...list].sort((a, b) => rank(b) - rank(a)))
  return out
}

/** Which folded storeys have to come back because something there just CHANGED (F4): a Trupp set
 *  onto one (a chip that was not there before, or moved there from another storey), or a Trupp on
 *  one whose alarm went to `crit`. A fold the user made over a Trupp that was already there – even
 *  an overdue one – stays: only a change unfolds. `before` is the last look; `null` on the first
 *  one, which only seeds (a restart keeps what the device had folded). */
export function storeysToReveal(before: ReadonlyMap<string, Pick<StoreyTeam, 'floor' | 'tone'>> | null, now: readonly StoreyTeam[], hidden: readonly number[]): number[] {
  if (!before) return []
  const out = new Set<number>()
  for (const t of now) {
    if (!hidden.includes(t.floor)) continue
    const was = before.get(t.id)
    if (!was || was.floor !== t.floor || (t.tone === 'crit' && was.tone !== 'crit')) out.add(t.floor)
  }
  return [...out]
}
