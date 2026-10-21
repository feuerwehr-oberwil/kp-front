// When a completed Objektbesuch stops being correctable (docs/object-visits.md · «The lock»).
//
// The SERVER owns the rule: it sends `lockedAt` with every visit it hands out — the completion
// plus `objectVisits.lockAfterHours` (24 h by default, null at a station that never locks). The
// app only compares that moment with the clock, so a device with a stale config can never offer
// an edit the server would refuse (owner, 20.10.2026: «open for more than a week»).
//
// No `lockedAt` ⇒ not locked: a draft, a discarded visit, or a completion the server has not
// seen yet (finished offline). That visit's correction is sent and the server decides.

/** The moment a visit goes view-only, as the device holds it. */
export type LockedAt = string | null | undefined

/** Is this visit view-only NOW? */
export function visitLocked(lockedAt: LockedAt, now: number = Date.now()): boolean {
  const at = lockedAt ? Date.parse(lockedAt) : NaN
  return Number.isFinite(at) && now >= at
}
