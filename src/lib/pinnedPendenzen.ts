import type { OpenReminder } from './reminders'

/** A Pendenz ticked off in the pinned block during THIS opening of the Verlauf, and the row it
 *  stood under (`after`, null = the top) when it was ticked. */
export type TickedHere = { r: OpenReminder; after: string | null }

/**
 * The pinned «Offene Pendenzen» block's rows: the open ones in lib/reminders' order, plus every
 * item ticked off here since the drawer opened, back in the slot it was ticked in (duck sweep
 * ELEM.2, 17.11.2026). The box is a two-way tick, so a mis-tap must stay where it happened to be
 * taken back; the drawer remounts on each open, so the next opening lists only what is open.
 * An item that is open again (reopened here or elsewhere) is the open list's, not a ticked copy.
 */
export function pinnedWithTicked(open: readonly OpenReminder[], ticked: ReadonlyMap<string, TickedHere>): OpenReminder[] {
  const out = [...open]
  const openIds = new Set(open.map((r) => r.id))
  for (const [id, { r, after }] of ticked) {
    if (openIds.has(id)) continue
    out.splice(after == null ? 0 : out.findIndex((x) => x.id === after) + 1, 0, r)
  }
  return out
}
