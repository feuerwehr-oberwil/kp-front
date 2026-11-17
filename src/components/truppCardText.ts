// What a Trupp's row and card SAY, as plain values: the clock (`collapsedClock`), the tier
// word (`tierMark`), the link board's tab line (`tabState`), the work squad's words
// (`plainWords`) and the state word (`truppStateWord`). Pure, and shared by TruppCard, the board's
// focus strip (AtemschutzView) and every picture of a Trupp (TwinTeamPill, the Trupp docks).

import { appConfig } from '../config/appConfig'
import { formatTime } from '../lib/format'
import { fmtClock, fmtElapsedFull, isAtemschutzTrupp, truppNeverDeployed, truppRegisteredAt, type TruppAlarm, type TruppLive } from '../lib/atemschutz'
import { truppStatusLabel } from '../lib/report'
import type { Trupp } from '../types'

/** What a Trupp's clock says — the phone row, every card's first line (RowLine) and the
 *  focus-strip tab all read it here, so no two views of one Trupp ever disagree: a crew inside ticks its own clock (Kontakt under PA, Einsatzzeit on a work
 *  squad), an Atemschutz-Trupp that is out ticks «Draussen seit» in the quiet tone, a work squad
 *  that is out says nothing, and «Nicht eingesetzt» keeps its static Anmeldezeit. */
export function collapsedClock(t: Trupp, live: TruppLive): { val: string; sub: string } {
  const az = appConfig.copy.atemschutz
  const out = live.status === 'raus'
  if (!isAtemschutzTrupp(t)) {
    if (out) return { val: '', sub: '' }
    return { val: fmtElapsedFull(t.entryTime ? live.elapsedSec : null), sub: az.elapsed }
  }
  if (out) {
    if (truppNeverDeployed(t)) {
      const reg = truppRegisteredAt(t)
      return reg != null
        ? { val: fmtTime(new Date(reg).toISOString()), sub: az.bandRegisteredAt }
        : { val: '', sub: '' }
    }
    return live.outSec != null ? { val: fmtElapsedFull(live.outSec), sub: az.outFor } : { val: '', sub: '' }
  }
  if (live.status === 'angemeldet') return { val: fmtClock(null), sub: az.elapsed }
  return { val: fmtClock(live.sinceContactSec), sub: az.sinceContact }
}

/** The tier as a WORD for a screen reader — the row's aria-label and the link board's tab. No
 *  glyph anywhere since 30.10.2026 (owner: «we don't need the triangle thing. red and notfall is
 *  already enough»; «remove the ugly clock icon»): «Überfällig» and the Alarmdruck stand in the
 *  red clock and the card's red edge, «Fällig» in the amber digits, and this word is what keeps
 *  them from riding on colour alone for assistive tech. A pressure alarm never says «Überfällig»
 *  (see `TruppAlarm.reason`). */
export function tierMark(alarm: TruppAlarm, sev: number): string | null {
  const az = appConfig.copy.atemschutz
  if (sev <= 0) return null
  if (alarm.reason === 'pressure') return az.clockAlarmPressure
  return sev >= 2 ? az.clockOverdue : az.rowDue
}

/** An ISO stamp as the board prints it (hh:mm), or nothing for a stamp that does not parse. */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatTime(d)
}

/** What a TAB of the handed-over phone board says under the name (Atemschutz-Link redesign, owner
 *  pick R1 on AB, 30.10.2026): a crew at the door says «Bereit» — it has no clock, and «–:––» read
 *  as a value — one on Rückzug says so beside its contact clock, every other shows the clock its
 *  row shows (`collapsedClock`). `tone` is the colour the tab gives the line. */
export interface TabState { word: string; clock: string; tone: 'ready' | 'rueckzug' | 'clock' }
export function tabState(t: Trupp, live: TruppLive): TabState {
  const az = appConfig.copy.atemschutz
  if (t.status === 'angemeldet') return { word: az.phoneSectionReady, clock: '', tone: 'ready' }
  const clock = collapsedClock(t, live).val
  return t.status === 'rueckzug' ? { word: az.status.rueckzug, clock, tone: 'rueckzug' } : { word: '', clock, tone: 'clock' }
}

/** Non-AS Trupp wording — APP ONLY (09.09., field ask). A work squad reports a task done, not a
 *  radio check, so the app says «Auftrag erledigt» / «Ohne Auftrag» / «Ohne Auftrag seit» for
 *  one, instead of borrowing Atemschutz vocabulary. The handed-over link board (`lite`) keeps
 *  today's words for EVERY Trupp on it, plain ones included — it is the one screen an outside
 *  operator was handed, and it must keep meaning what it always meant.
 *  `truppStatusLabel` (lib/report.ts) stays AS vocabulary — it also prints the Rapport — so this
 *  only swaps its plain «Draussen» result at the view layer, never «Nicht eingesetzt» / «Von
 *  Tafel entfernt», which read true for a work squad exactly as they are. */
export function plainWords(t: Trupp, lite: boolean) {
  const az = appConfig.copy.atemschutz
  const plain = !lite && !isAtemschutzTrupp(t)
  return {
    exit: plain ? az.actExitPlain : az.actExit,
    outFor: plain ? az.outForPlain : az.outFor,
    status: (label: string) => (plain && label === az.status.raus ? az.statusPlainOut : label),
  }
}

/** A Trupp's state as ONE word, the board's (ENT.7, 17.11.2026): `truppStatusLabel` through
 *  `plainWords`, so a work squad that is out reads «Ohne Auftrag», never the PA-out «Draussen».
 *  The map's selected pill and both Trupp docks (Karte, Plan) read it here; the card itself
 *  derives the live status first (überfällig) and then goes through the same `plainWords`. */
export function truppStateWord(t: Trupp, lite = false): string {
  return plainWords(t, lite).status(truppStatusLabel(t))
}
