// The Rapport GROUP — Rapport · Anwesenheit · Material — and the device-side memory of which of
// the three this Einsatz was last left on. Pure and storage-injectable so the rules are
// node-testable: components/PageSwitcher and NavRail own the pixels, this file owns the policy.
//
// Why a group at all: on a phone the bottom bar holds five tiles (18.09.2026), and these three
// were the group that had to give two of them up. They stayed three ORDINARY, separate full
// pages — folding Anwesenheit and Material into the Rapport as extra tabs was tried the same day
// and thrown out: a whole surface mounted under the Rapport's own tab strip put three
// navigations on one screen, one above the other. So the bar keeps ONE tile for the three, it
// opens the page you were last on, and the switcher at the foot of all three moves between them
// without a trip back up to the bar.

/** One of the three pages the phone's «Rapport» tile stands for. These are `mode` values — the
 *  same ones the vertical rail sets with three tiles of its own. */
export type RapportPage = 'rapport' | 'anwesenheit' | 'mittel'

/**
 * The switcher's order: the Rapport first, then the two pages it is filled in from.
 *
 * ⚠️ The Rapport leads because it is the page the tile is NAMED after and the one the group is
 * about — the other two are where its numbers come from. It is also the stable anchor: whichever
 * of the three you are standing on, «Rapport» is in the same place.
 */
export const RAPPORT_PAGES: RapportPage[] = ['rapport', 'anwesenheit', 'mittel']

/** Is this `mode` one of the three? Used both to light the bar's tile and to decide whether the
 *  switcher belongs on screen at all. */
export function isRapportPage(mode: string): mode is RapportPage {
  return (RAPPORT_PAGES as string[]).includes(mode)
}

/** Per-incident, per-DEVICE, and deliberately session-scoped — the same shape and the same
 *  reasoning as the Anwesenheit view's own tab memory (AnwesenheitView · TAB_KEY, and the note
 *  left in lib/prefs where that used to be a cookie): coming back to the page you were on across
 *  a reload is worth keeping, a choice made last week deciding where a fresh Einsatz opens is
 *  not. */
const KEY = 'kp-front-rapport-page'

/** Storage-shaped for tests; `sessionStorage` in the app. */
type Store = Pick<Storage, 'getItem' | 'setItem'>

const store = (s?: Store): Store | undefined =>
  s ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)

/** the page this device last left the group on for THIS Einsatz, or null. Another incident always
 *  reads as null: the stamp is part of the record, so yesterday's page cannot open tonight's
 *  alarm. */
export function readRapportPage(incidentId: string, s?: Store): RapportPage | null {
  try {
    const raw = store(s)?.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { incidentId?: string; page?: string }
    if (v.incidentId !== incidentId) return null
    return v.page && isRapportPage(v.page) ? v.page : null
  } catch { return null } // private mode, or a box written by an older build
}

export function writeRapportPage(incidentId: string, page: RapportPage, s?: Store): void {
  try { store(s)?.setItem(KEY, JSON.stringify({ incidentId, page })) } catch { /* private mode */ }
}

/**
 * Which of the three the bar's «Rapport» tile opens.
 *
 * 1. the one this device last left the group on, for this Einsatz — the Appell is «tile →
 *    correct a name → away → tile», several times over, and a tap that always landed on the
 *    Rapport would cost an extra one on every single round trip;
 * 2. else, with NOBODY marked present yet, «Anwesenheit» — at that moment the Rapport has
 *    nothing in it to read and the crew is arriving, so the arrival minutes are the only thing
 *    anybody opens this group for;
 * 3. else the Rapport itself, which is what the tile says.
 */
export function initialRapportPage(
  { incidentId, presentCount, store: s }:
  { incidentId: string; presentCount: number; store?: Store },
): RapportPage {
  return readRapportPage(incidentId, s) ?? (presentCount === 0 ? 'anwesenheit' : 'rapport')
}
