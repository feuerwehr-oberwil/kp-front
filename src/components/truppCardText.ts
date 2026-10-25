// What a Trupp's row and card SAY, as plain values: the clock (`collapsedClock`) and the tier
// glyph (`tierMark`). Pure, and shared by TruppCard and the board's focus strip (AtemschutzView).

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

/** The tier as a GLYPH, not colour alone (B5, 08.10.2026: sunlight, colour-blind). A different
 *  glyph per tier, so the SHAPE tells them apart: the clock for «Fällig» (the radio check is due),
 *  the warning triangle for «Überfällig» and for the Alarmdruck. Only the glyph is drawn (owner,
 *  09.10.2026: «Symbol only»); `text` is the word for the row's aria-label and the hover title,
 *  and a pressure alarm never says «Überfällig» (see `TruppAlarm.reason`). `withPressure` false
 *  where the caller says the Alarmdruck in words already (the card's state line, with its limit). */
export interface TierMark { icon: string; text: string; crit: boolean }
export function tierMark(alarm: TruppAlarm, sev: number, withPressure: boolean): TierMark | null {
  const az = appConfig.copy.atemschutz
  if (sev <= 0) return null
  if (alarm.reason === 'pressure') return withPressure ? { icon: 'warn', text: az.clockAlarmPressure, crit: true } : null
  return sev >= 2 ? { icon: 'warn', text: az.clockOverdue, crit: true } : { icon: 'clock', text: az.rowDue, crit: false }
}

/** An ISO stamp as the board prints it (hh:mm), or nothing for a stamp that does not parse. */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatTime(d)
}
