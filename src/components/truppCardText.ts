// What a Trupp's row and card SAY, as plain values: the clock (`collapsedClock`), the tier
// glyph (`tierMark`) and the link board's tab line (`tabState`). Pure, and shared by TruppCard and
// the board's focus strip (AtemschutzView).

import { appConfig } from '../config/appConfig'
import { formatTime } from '../lib/format'
import { fmtClock, fmtElapsedFull, isAtemschutzTrupp, truppNeverDeployed, truppRegisteredAt, type TruppAlarm, type TruppLive } from '../lib/atemschutz'
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

/** The tier as a word for the row's aria-label and the hover title, and — for the red tiers —
 *  as a GLYPH (B5, 08.10.2026: sunlight, colour-blind): `crit` = «Überfällig» or the Alarmdruck,
 *  drawn as the warning triangle in front of the clock. «Fällig» draws NO glyph since 30.10.2026
 *  (owner: «remove the ugly clock icon» – the small clock under the amber digits): its amber
 *  carries it, and it stays a word for a screen reader. A pressure alarm never says «Überfällig»
 *  (see `TruppAlarm.reason`). `withPressure` false where the caller says the Alarmdruck in words
 *  already (the card's state line, with its limit). */
export interface TierMark { text: string; crit: boolean }
export function tierMark(alarm: TruppAlarm, sev: number, withPressure: boolean): TierMark | null {
  const az = appConfig.copy.atemschutz
  if (sev <= 0) return null
  if (alarm.reason === 'pressure') return withPressure ? { text: az.clockAlarmPressure, crit: true } : null
  return sev >= 2 ? { text: az.clockOverdue, crit: true } : { text: az.rowDue, crit: false }
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
