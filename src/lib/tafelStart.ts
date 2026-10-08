import type { BoardAnno } from '../types'

/**
 * The starter cards on the empty Tafel (08.10.2026, «Womit beginnen?») — the rules, kept pure.
 *
 * ⚠️ THE RETURN RULE: the cards show on the Tafel only while its sheet holds nothing AND this
 * device has never seen anything on this Einsatz's Tafel. The first time the sheet holds an
 * object, the Einsatz is remembered on this device (`markTafelUsed`, a tiny localStorage flag like
 * the nearby banner's) and the cards never come back for it — not after «alles löschen», and so
 * not in the window between a delete-all and its ↶, where a layer popping up and vanishing again
 * would be noise. A fresh sheet on a fresh Einsatz is the only place they appear. The plain
 * «Leeres Blatt» hint stands in for them afterwards.
 *
 * Never on a read-only sheet (viewer, el, replay): every card is an act.
 */

export const TAFEL_ID = 'tafel'

/** An object at most this far from the Einsatzort is «the» object — «Objekt wählen» is suggested. */
export const OBJECT_SUGGEST_M = 100

export type StartSuggestion = 'object' | 'building' | null

/**
 * Which card carries the «Vorschlag» badge: an object from the database within ~100 m (or one
 * the server matched by address) wins; otherwise the building outline at the pin, when the
 * Einsatz has a location to put a pin on; otherwise none.
 */
export function startSuggestion(
  nearest: { distanceM: number | null | undefined; addressMatch?: boolean | null } | null | undefined,
  hasLocation: boolean,
): StartSuggestion {
  if (nearest && (nearest.addressMatch === true || (nearest.distanceM != null && nearest.distanceM <= OBJECT_SUGGEST_M))) return 'object'
  return hasLocation ? 'building' : null
}

export interface StartVisibility {
  planId: string
  annos: readonly BoardAnno[]
  /** this device has seen the Tafel of this Einsatz hold something (`tafelUsed`) */
  everUsed: boolean
  readOnly: boolean
  /** the cards were waved away this visit («oder einfach losskizzieren», or a tool was armed) */
  dismissed: boolean
}

export function tafelStartVisible({ planId, annos, everUsed, readOnly, dismissed }: StartVisibility): boolean {
  return planId === TAFEL_ID && annos.length === 0 && !everUsed && !readOnly && !dismissed
}

const KEY = 'kp.tafel.used'
const read = (): string[] => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[] } catch { return [] }
}

export function tafelUsed(incidentId: string | undefined): boolean {
  return !!incidentId && read().includes(incidentId)
}

/** Remember that this Einsatz's Tafel held something — the last 100 Einsätze, never unbounded. */
export function markTafelUsed(incidentId: string | undefined): void {
  if (!incidentId || tafelUsed(incidentId)) return
  try {
    localStorage.setItem(KEY, JSON.stringify([...read(), incidentId].slice(-100)))
  } catch { /* private mode / storage disabled → the cards may show again on an emptied sheet */ }
}
