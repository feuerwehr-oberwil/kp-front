// «Geschoss entfernen»'s Verlauf words. The removal asks nothing (the delete rule, 13.11.2026,
// lib/removalToast): the storey goes at once and its confirm-with-undo toast brings it back with
// every own anno it deleted or cut short (workspace/useGebaeudeActions · removeFloor). Until then
// it asked whenever the sweep LOST something (`stackFloors · removeStorey · lost`) – and showed
// that toast afterwards anyway.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'

/** The Verlauf row for the removal itself — «Geschoss 3. OG entfernt», with how many of the
 *  storey's own markings went or were cut short when that is any (25.09.2026: only the ↶ used to
 *  write a row). «entfernt», the word of every removal from the picture; «gelöscht» is a Feuer. */
export function storeyRemovedRow(storey: string, lost: number): string {
  const wb = appConfig.copy.whiteboard
  return lost > 0 ? fillTemplate(wb.floorRemovedLogMarks, { floor: storey, n: lost }) : fillTemplate(wb.floorRemovedLog, { floor: storey })
}

/** …and its counter-row when the storey comes back — by the toast or by ↶ alike (25.09.2026). */
export function storeyRestoredRow(storey: string): string {
  return fillTemplate(appConfig.copy.whiteboard.floorRestoredLog, { floor: storey })
}

/** …and its creation row — «Geschoss 4. OG hinzugefügt» (26.09.2026: «+ OG / + UG» wrote none,
 *  while its ↶ wrote a row about it). */
export function storeyAddedRow(storey: string): string {
  return fillTemplate(appConfig.copy.whiteboard.floorAddedLog, { floor: storey })
}

/** The SUBJECT every storey row names (types · TimelineEvent.subjectId), so the repeat fold keeps
 *  two storeys apart and ends a storey's run at its next act (lib/verlauf · repeatRuns). */
export const storeySubject = (floor: number): string => `storey:${floor}`
