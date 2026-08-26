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

/**
 * ── Grosse Auswahl: der getippte Punkt zählt ──────────────────────────────────────────────────
 * Does the whole selection still fit in the open strip beside the panel? If it does, its BOX is a
 * fair description of «where the operator is looking» and the box nudge brings all of it clear.
 * If it does not — a hose line drawn right across the screen — the box says nothing useful: its
 * far edge is somewhere off-stage, and clearing that edge pans the map past the piece of the line
 * that was actually tapped.
 */
export function fitsBesidePanel(box: NudgeBox, panel: NudgeRect, margin = NUDGE_MARGIN): boolean {
  return box.maxX - box.minX <= panel.left - 2 * margin
}

/** The bottom-sheet twin: does the extent fit in the strip above the sheet? */
export function fitsAbovePanel(box: NudgeBox, panel: { top: number }, margin = NUDGE_MARGIN): boolean {
  return box.maxY - box.minY <= panel.top - 2 * margin
}

/**
 * The nudge both surfaces actually call for a selected drawing: box rule for anything that fits,
 * TAP POINT for anything that does not.
 *
 * ⚠️ On a screen-spanning line the box rule overshot (26.08. field test) — tapping a long Leitung
 * threw the map sideways, away from the spot that had just been aimed at. Anchoring on the tap
 * point fixes both halves of that: the pan is measured from the place the finger actually was, and
 * a tap that was already clear of the panel moves the camera not at all (`panelNudge` returns null
 * there). Without a tap point — a Verlauf jump, a freshly finished stroke — nothing changes: the
 * box rule still runs, so small objects behave exactly as before.
 */
export function panelNudgeSelection(
  box: NudgeBox,
  tap: { x: number; y: number } | null | undefined,
  panel: NudgeRect,
  margin = NUDGE_MARGIN,
): [number, number] | null {
  return tap && !fitsBesidePanel(box, panel, margin)
    ? panelNudge(tap, panel, margin)
    : panelNudgeBox(box, panel, margin)
}

/** Bottom-sheet twin of `panelNudgeSelection` (phones): same rule, straight up. */
export function panelNudgeSelectionUp(
  box: NudgeBox,
  tap: { x: number; y: number } | null | undefined,
  panel: { top: number },
  margin = NUDGE_MARGIN,
): [number, number] | null {
  return tap && !fitsAbovePanel(box, panel, margin)
    ? panelNudgeUp(tap, panel, margin)
    : panelNudgeBoxUp(box, panel, margin)
}

/** a panel covering (almost) the surface's full width is the bottom-sheet presentation */
export function isBottomSheet(panelWidth: number, surfaceWidth: number): boolean {
  return panelWidth >= surfaceWidth * 0.9
}
