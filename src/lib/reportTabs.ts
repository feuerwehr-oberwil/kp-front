// The Einsatzrapport's phone tabs — which tabs exist, which one opens, and the device-side
// memory of the last one used. Pure and storage-injectable so the rules are node-testable:
// components/ReportPreflight owns the pixels, this file owns the policy.

/**
 * A tab of the Rapport on a phone.
 *
 * `bericht` · `werwas` · `beilagen` are the Rapport's own three (they split one five-screen
 * page into three; see ReportPreflight · PhoneTab).
 *
 * `anwesenheit` · `mittel` only exist where the phone bar has FOLDED them in (18.09.2026): a
 * 360px bar holds five tiles, so Anwesenheit and Material gave up theirs and became tabs of the
 * surface they are read and corrected from anyway. On tablet/desktop they are their own
 * surfaces with their own rail tiles and these two values never appear.
 */
export type ReportTab = 'anwesenheit' | 'mittel' | 'bericht' | 'werwas' | 'beilagen'

/** The Rapport's own tabs, in the order of the printed rapport. */
export const REPORT_TABS: ReportTab[] = ['bericht', 'werwas', 'beilagen']

/**
 * …and the folded phone set.
 *
 * ⚠️ Anwesenheit and Material come FIRST, ahead of «Bericht». The order is the working order,
 * not the printing order: those two are touched throughout the Einsatz (somebody arrives, a Sack
 * Bindemittel goes on the truck) while Bericht/Beilagen are written at the end of it. Putting
 * them at the left edge also puts them under the thumb that just tapped the Rapport tile on the
 * bar below. The printed rapport's order is untouched — it lives in the DOM, and no tab reorders
 * anything (report_pdf.py / admin/capturePdf.ts).
 */
export const REPORT_TABS_FOLDED: ReportTab[] = ['anwesenheit', 'mittel', ...REPORT_TABS]

/** the tab strip for this device: folded (phone, Anwesenheit + Material in) or not. */
export function reportTabs(folded: boolean): ReportTab[] {
  return folded ? REPORT_TABS_FOLDED : REPORT_TABS
}

/** Per-incident, per-DEVICE, and deliberately session-scoped — the same shape and the same
 *  reasoning as the Anwesenheit view's own tab memory (AnwesenheitView · TAB_KEY, and the note
 *  left in lib/prefs where this used to be a cookie): coming back to your tab across a reload is
 *  worth keeping, a choice made last week deciding where a fresh Einsatz opens is not. */
const KEY = 'kp-front-rapport-tab'

/** Storage-shaped for tests; `sessionStorage` in the app. */
type Store = Pick<Storage, 'getItem' | 'setItem'>

const store = (s?: Store): Store | undefined =>
  s ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)

/** the tab this device last used for THIS Einsatz, or null. Another incident always reads as
 *  null: the stamp is part of the record, so yesterday's tab cannot open tonight's alarm. */
export function readReportTab(incidentId: string, s?: Store): ReportTab | null {
  try {
    const raw = store(s)?.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { incidentId?: string; tab?: string }
    if (v.incidentId !== incidentId) return null
    return REPORT_TABS_FOLDED.includes(v.tab as ReportTab) ? (v.tab as ReportTab) : null
  } catch { return null } // private mode, or a box written by an older build
}

export function writeReportTab(incidentId: string, tab: ReportTab, s?: Store): void {
  try { store(s)?.setItem(KEY, JSON.stringify({ incidentId, tab })) } catch { /* private mode */ }
}

/**
 * Which tab the Rapport opens on.
 *
 * 1. the last one used on this device for this Einsatz — «tap Rapport» has to land where the
 *    operator was, or the Appell loop (correct a name, glance at the Bericht, back) pays a tap
 *    every single time;
 * 2. else, on a folded phone with NOBODY marked present yet, «Anwesenheit» — at that moment the
 *    Rapport has nothing in it to read and the crew is arriving, so the arrival minutes are the
 *    only thing anyone opens it for;
 * 3. else «Bericht», the first section of the printed rapport, which is what this surface has
 *    always opened on.
 *
 * A remembered tab that this device cannot show (a phone memory read on a tablet, after the rail
 * unfolded) falls through to the default rather than selecting a tab that is not in the strip.
 */
export function initialReportTab(
  { incidentId, folded, presentCount, store: s }:
  { incidentId: string; folded: boolean; presentCount: number; store?: Store },
): ReportTab {
  const remembered = readReportTab(incidentId, s)
  if (remembered && reportTabs(folded).includes(remembered)) return remembered
  return folded && presentCount === 0 ? 'anwesenheit' : 'bericht'
}
