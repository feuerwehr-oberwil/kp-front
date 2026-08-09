import type { AttendanceEntry, AttendanceOrt, AttendanceState } from '../types'
import { isPresent } from './attendanceIntervals'

/**
 * Am Einsatzort oder noch im Magazin — «wen könnte ich noch nachziehen?»
 *
 * That question is about THIS MINUTE, so this is one state per person and no history at all: the
 * alternative is a second kind of presence block, and a record of every walk between the Magazin
 * and the scene is a lot of rows nobody reads. What DID happen is in the Verlauf, where every
 * change writes a line — so the record still answers «wann kam die zweite Gruppe nach».
 *
 * ⚠️ THE DEFAULT IS `'scene'`, everywhere and deliberately:
 *  · every attendance entry written before 2026-08-09 has no `ort`, and before this existed
 *    «anwesend» meant «here» — reading those as «Magazin» would rewrite history for every
 *    closed Einsatz on the server;
 *  · in the app the EL ticks people who are standing at the Kommandoposten, so the tick that
 *    means «here» must not need a second tap to say so.
 * The QR poster is the one surface that ASKS instead, because it hangs in the Magazin but is
 * also scanned on the way back in — see docs/CONFIGURATION.md and the capture sheet.
 */
export function ortOf(e: AttendanceEntry | undefined): AttendanceOrt {
  return e?.ort === 'station' ? 'station' : 'scene'
}

/** The other one — the whole control is a toggle, so this is the whole of «what does a tap do». */
export const otherOrt = (o: AttendanceOrt): AttendanceOrt => (o === 'scene' ? 'station' : 'scene')

export interface OrtCounts {
  scene: number
  station: number
}

/** How many of the people who are HERE are at the scene, and how many are still at the Magazin.
 *  Only the present are counted: somebody who has gone home is at neither. */
export function ortCounts(attendance: AttendanceState): OrtCounts {
  let scene = 0
  let station = 0
  for (const e of Object.values(attendance)) {
    if (!isPresent(e)) continue
    if (ortOf(e) === 'station') station++
    else scene++
  }
  return { scene, station }
}
