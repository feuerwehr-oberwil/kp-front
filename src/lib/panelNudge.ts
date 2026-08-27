// Shared Lage/Plan viewport math. Selection never changes object coordinates: it only pans the
// camera/board enough to keep the useful part inside the padded space left by panels and sheets.

/** margin ≈ selection halo + rotate-handle ring + breathing room */
export const NUDGE_MARGIN = 56

/** Screen-space bounding box. Coordinates may be container-local (Lage) or client-global (Plan). */
export interface NudgeBox { minX: number; maxX: number; minY: number; maxY: number }

/** The genuinely usable part of a surface, in the same coordinate space as the selection. */
export function visibleWorkRect(
  surface: NudgeBox,
  panel: NudgeBox | null,
  bottomSheet: boolean,
  margin = NUDGE_MARGIN,
): NudgeBox {
  const out = {
    minX: surface.minX + margin,
    maxX: surface.maxX - margin,
    minY: surface.minY + margin,
    maxY: surface.maxY - margin,
  }
  if (panel) {
    if (bottomSheet) out.maxY = Math.min(out.maxY, panel.minY - margin)
    else out.maxX = Math.min(out.maxX, panel.minX - margin)
  }
  // Extremely small/landscape viewports can leave less than two margins. Collapse to a usable
  // centre line instead of returning an inverted rectangle whose clamp would move unpredictably.
  if (out.maxX < out.minX) out.minX = out.maxX = (surface.minX + Math.min(surface.maxX, panel?.minX ?? surface.maxX)) / 2
  if (out.maxY < out.minY) out.minY = out.maxY = (surface.minY + Math.min(surface.maxY, bottomSheet && panel ? panel.minY : surface.maxY)) / 2
  return out
}

/** Minimal pan delta that puts a point inside the padded, unobscured work rectangle. */
export function nudgePointIntoRect(pt: { x: number; y: number }, rect: NudgeBox): [number, number] | null {
  const x = Math.max(rect.minX, Math.min(rect.maxX, pt.x))
  const y = Math.max(rect.minY, Math.min(rect.maxY, pt.y))
  const dx = pt.x - x, dy = pt.y - y
  return dx || dy ? [dx, dy] : null
}

function nudgeAxis(min: number, max: number, visibleMin: number, visibleMax: number, anchor?: number | null): number {
  const span = max - min, available = visibleMax - visibleMin
  if (span <= available) {
    if (min < visibleMin) return min - visibleMin
    if (max > visibleMax) return max - visibleMax
    return 0
  }
  // A screen-spanning line is intentionally not fitted. Keep the part the operator tapped in
  // view; without a tap, move only when the whole extent is outside the usable rectangle.
  if (anchor != null) return anchor - Math.max(visibleMin, Math.min(visibleMax, anchor))
  if (max < visibleMin) return max - visibleMin
  if (min > visibleMax) return min - visibleMax
  return 0
}

/**
 * Minimal pan for a point or extent against all four padded viewport borders and any open panel.
 * Small geometry is kept wholly visible; oversized geometry stays at the current zoom and only
 * the tapped/nearest part is kept visible.
 */
export function nudgeSelectionIntoRect(
  box: NudgeBox,
  tap: { x: number; y: number } | null | undefined,
  rect: NudgeBox,
): [number, number] | null {
  const dx = nudgeAxis(box.minX, box.maxX, rect.minX, rect.maxX, tap?.x)
  const dy = nudgeAxis(box.minY, box.maxY, rect.minY, rect.maxY, tap?.y)
  return dx || dy ? [dx, dy] : null
}

export function rectCenter(rect: NudgeBox): { x: number; y: number } {
  return { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 }
}

/** A panel covering (almost) the surface's full width is the bottom-sheet presentation. */
export function isBottomSheet(panelWidth: number, surfaceWidth: number): boolean {
  return panelWidth >= surfaceWidth * 0.9
}
