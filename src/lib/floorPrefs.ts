// Which storeys of the Gebäude stack THIS DEVICE is looking at, per incident.
//
// Hiding a Geschoss is a way of LOOKING at the building, not a fact about it (16.09.2026): the
// EL reading the 1. OG on a phone wants the other three storeys out of the way, the Kommandotisch
// wants the whole section — and neither may decide that for the other. So it never reaches the
// synced workspace: the storey keeps its ink, the Karte keeps showing it, and the Rapport prints
// the full stack whatever this device has folded away. Same reasoning, same shape and the same
// best-effort storage as lib/layerPrefs.
//
// Stored as the HIDDEN set rather than the visible one, because that is the value that survives a
// pack gaining a storey: a floor nobody has hidden is shown, including one that did not exist when
// the device last looked.

const key = (incidentId: string) => `kp.floors.hidden.${incidentId}`

/** The storeys this device has folded away on this incident. Empty = the whole stack. */
export function loadHiddenFloors(incidentId: string): number[] {
  try {
    const raw = localStorage.getItem(key(incidentId))
    if (!raw) return []
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []
  } catch { return [] }
}

/** Remember what this device has folded away. Never reaches the server. */
export function saveHiddenFloors(incidentId: string, floors: readonly number[]): void {
  try {
    if (floors.length) localStorage.setItem(key(incidentId), JSON.stringify([...floors]))
    else localStorage.removeItem(key(incidentId)) // «alles sichtbar» is the default, not a stored state
  } catch { /* preference only */ }
}

/** What is left to draw. ⚠️ Never empty: hiding the last visible storey would leave a board with
 *  no tiles and no way back to one, so the request is ignored and the whole stack stays. */
export const shownFloors = (all: readonly number[], hidden: readonly number[]): number[] => {
  const out = all.filter((f) => !hidden.includes(f))
  return out.length ? out : [...all]
}
