// Minimal-nudge math for "the tapped object is hidden behind the details panel". The
// ContextPanel/DrawEditor (.ctx) is an overlay docked to the right edge of the surface; a
// selection landing under it — including its halo/rotate handles — would be invisible while
// being edited. Both surfaces (Lage map + Plan board, parity) call this with the selection's
// screen point and the panel's rect (same coordinate space) and apply the returned pan delta.
// Deliberately minimal: selections in the open area return null (the camera never moves), an
// occluded one is shifted just far enough to clear the panel's left edge plus a margin.

export interface NudgeRect { left: number; top: number; bottom: number }

/** margin ≈ selection halo + rotate-handle ring + breathing room */
export const NUDGE_MARGIN = 56

/**
 * Pan delta [dx, dy] (in px, to apply as a camera move) that brings `pt` clear of `panel`,
 * or null when it is already visible. Horizontal-only: the panel spans nearly the full
 * height, so clearing its left edge is always the shortest calm move.
 */
export function panelNudge(
  pt: { x: number; y: number },
  panel: NudgeRect,
  margin = NUDGE_MARGIN,
): [number, number] | null {
  if (pt.y < panel.top - margin || pt.y > panel.bottom + margin) return null
  const clearX = panel.left - margin
  if (pt.x <= clearX) return null
  return [pt.x - clearX, 0]
}

/**
 * The bottom-sheet variant (phones): the panel spans the full width along the bottom,
 * so the calm move is straight up — clear the sheet's top edge plus the margin.
 */
export function panelNudgeUp(
  pt: { x: number; y: number },
  panel: { top: number },
  margin = NUDGE_MARGIN,
): [number, number] | null {
  const clearY = panel.top - margin
  if (pt.y <= clearY) return null
  return [0, pt.y - clearY]
}

/** screen-space bounding box of a drawing's projected points (incl. a circle's radius) */
export interface NudgeBox { minX: number; maxX: number; minY: number; maxY: number }

/**
 * Box variant for drawings (line / area / circle): their footprint is an extent, not a
 * point. Same minimal move — clear the panel's left edge — but capped so the drawing's
 * own left edge never leaves the surface: an extent wider than the open area only shifts
 * until its left edge reaches the margin (partially visible beats fully hidden).
 */
export function panelNudgeBox(
  box: NudgeBox,
  panel: NudgeRect,
  margin = NUDGE_MARGIN,
): [number, number] | null {
  if (box.maxY < panel.top - margin || box.minY > panel.bottom + margin) return null
  const clearX = panel.left - margin
  if (box.maxX <= clearX) return null
  const dx = Math.min(box.maxX - clearX, Math.max(0, box.minX - margin))
  return dx > 0 ? [dx, 0] : null
}

/** bottom-sheet box variant: shift up, capped so the extent's top edge stays on-surface */
export function panelNudgeBoxUp(
  box: NudgeBox,
  panel: { top: number },
  margin = NUDGE_MARGIN,
): [number, number] | null {
  const clearY = panel.top - margin
  if (box.maxY <= clearY) return null
  const dy = Math.min(box.maxY - clearY, Math.max(0, box.minY - margin))
  return dy > 0 ? [0, dy] : null
}

/** a panel covering (almost) the surface's full width is the bottom-sheet presentation */
export function isBottomSheet(panelWidth: number, surfaceWidth: number): boolean {
  return panelWidth >= surfaceWidth * 0.9
}
