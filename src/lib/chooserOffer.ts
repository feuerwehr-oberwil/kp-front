// A group tile's list opens BY ITSELF the first time the tile is used in an Einsatz. Pure and
// storage-injectable so the rule is node-testable: NavRail owns the pixels (the tile
// and its chooser), this file owns the policy.
//
// Why: the folded phone nav bar (18.09.2026) carries a tile that stands for a GROUP — «Pläne» for
// every plan document — and the list behind it is reached by a second tap or a hold: two gestures nobody can recognise off a tile that looks
// like its neighbours. An operator who does not already know lands on whichever member happens
// to be first and never learns that there are more. So the first use shows the list unasked: it
// says «there are several, and this is where they live», once, at the moment the question is
// actually being asked. After that the tile is the fast door it was built to be — straight to
// the member that was last used.

/** the group tiles that offer themselves — each remembers its own Einsatz. One today; keyed, so
 *  a second group gets its own slot instead of sharing this one's. */
export type OfferedGroup = 'plans'

/** Per-DEVICE and single-slot per group: only the Einsatz the list was last offered for is
 *  remembered, so the box never grows and another incident always reads as «not offered yet».
 *  localStorage rather than the session (lib/rapportPages): a phone that killed the PWA
 *  mid-Einsatz must not be taught the same thing again on every cold start. */
const KEY = 'kp-front-chooser-offered'
const key = (group: OfferedGroup) => `${KEY}:${group}`

/** Storage-shaped for tests; `localStorage` in the app. */
type Store = Pick<Storage, 'getItem' | 'setItem'>

const store = (s?: Store): Store | undefined =>
  s ?? (typeof localStorage === 'undefined' ? undefined : localStorage)

/** …and the same slots in memory, for a device whose storage refuses (private mode): without
 *  them the list would open on EVERY use there, which is the opposite of once. */
const offeredHere: Partial<Record<OfferedGroup, string>> = {}

/** has this device already been shown this group's list for THIS Einsatz? */
export function chooserOffered(group: OfferedGroup, incidentId: string, s?: Store): boolean {
  if (offeredHere[group] === incidentId) return true
  try { return store(s)?.getItem(key(group)) === incidentId } catch { return false } // private mode
}

/** …written whenever the list opens, by whichever door: somebody who found the hold on their own
 *  has nothing left to be taught. */
export function markChooserOffered(group: OfferedGroup, incidentId: string, s?: Store): void {
  offeredHere[group] = incidentId
  try { store(s)?.setItem(key(group), incidentId) } catch { /* private mode */ }
}

/**
 * Should the tap that goes to the group's last-used member open the list on top of it?
 *
 * Only with a choice to make (`many`), and only once per Einsatz per device. The tap still does
 * its ordinary job first — the list lies over a real destination (the last-open plan), so closing it without picking is a complete answer too.
 */
export function offerChooser(
  { group, incidentId, many, store: s }:
  { group: OfferedGroup; incidentId: string | undefined; many: boolean; store?: Store },
): boolean {
  return many && !!incidentId && !chooserOffered(group, incidentId, s)
}
