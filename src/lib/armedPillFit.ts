// The armed tool's pill row (components/ArmedToolPill) folds instead of ellipsising (owner, sweep
// 30.10.2026 #8: «Fahrze…»): the name first, then «Mehrere platzieren»'s word – on the top bar's
// ladder (lib/useHeadFit · climbLadder), measured. ArmedToolPill runs it via useHeadFit; the row's
// `data-fit` steps are drawn in 09-whiteboard · .armed-pill-row.
import { climbLadder } from './useHeadFit'

/** Does the row NOT fit – the name or the toggle's word cut, or the row painting past its edge? */
export function armedPillCrowded(row: HTMLElement): boolean {
  if (row.scrollWidth > row.clientWidth + 1) return true
  for (const el of row.querySelectorAll<HTMLElement>('.armed-pill-name, .armed-pill-lock > span')) {
    if (el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1) return true
  }
  return false
}

/** Fold until the row fits: step 1 the name, step 2 the toggle's word (`data-fit` on the row,
 *  09-whiteboard · .armed-pill-row). Every fit starts at 0, so a wider screen gives the words back. */
export function fitArmedPill(row: HTMLElement, crowded: (row: HTMLElement) => boolean = armedPillCrowded): number {
  const lock = row.querySelector<HTMLElement>('.armed-pill-lock')
  return climbLadder(lock ? 2 : 1, (step) => {
    if (step) row.dataset.fit = String(step)
    else delete row.dataset.fit
    lock?.toggleAttribute('data-holdexplain', step >= 2)
  }, () => crowded(row))
}
