import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { confirmDialog } from './ui'

/**
 * «Geschoss entfernen» asks only when the removal LOSES something (24.09.2026): an own anno it
 * deletes or cuts short, counted by the very sweep that performs it (`stackFloors ·
 * removeStorey · lost`). A Karte object shown on the storey is not lost — it stays on the Karte
 * — so a storey showing only those goes without a question; the confirm-with-undo toast after
 * the act is the way back either way. It used to ask whenever ANYTHING was drawn there, the
 * Karte's projections included, and said nothing about how much.
 */
export async function askStoreyRemoval(lost: number, storey: string): Promise<boolean> {
  if (lost <= 0) return true
  const wb = appConfig.copy.whiteboard
  return confirmDialog({
    title: wb.removeFloor,
    message: lost === 1
      ? fillTemplate(wb.removeFloorConfirmOne, { floor: storey })
      : fillTemplate(wb.removeFloorConfirm, { floor: storey, n: lost }),
    confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true,
  })
}

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
