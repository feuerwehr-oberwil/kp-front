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
    confirmLabel: wb.removeFloor, cancelLabel: appConfig.copy.cancel, danger: true,
  })
}
