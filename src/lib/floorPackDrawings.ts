import type { PlanPt } from './georef'

/*
 * A floor pack's storey drawings as they lie on ONE sheet's board, and the point maps through
 * them – the leaf half of lib/floorPackBinding (which lays them: `sheetDrawings`). Kept apart and
 * free of runtime imports so the unified-object bake (lib/tacticalObjects, in the entry chunk) can map
 * through a drawing without pulling the pack code in with it.
 */

/** A page's place on the board, as fractions of it (planTiles · PageBox without the page) */
export interface BoardBox { left: number; top: number; width: number; height: number }
export const UNIT_BOX: BoardBox = { left: 0, top: 0, width: 1, height: 1 }

/** One storey drawing on a plain sheet that shows a floor pack's pages – Modul 6 with its storeys
 *  drawn side by side, or one storey per page: which drawing it is (storey + part, as `floorKey`),
 *  its rectangle in the BOARD's normalized coordinates, and its join shift onto the reference
 *  drawing with the two page boxes that shift is measured between. */
export interface SheetDrawing {
  storey: number
  part: number
  clip: [number, number, number, number]
  /** `FloorPackTile.shift`, in PAGE coordinates: a point p of this drawing's page is the building
   *  point p + shift of the reference drawing's page – the one the pack's map fit is measured on */
  shift: [number, number]
  /** this drawing's page on the board */
  page: BoardBox
  /** the reference drawing's page on the board; the whole board when the sheet does not show
   *  that page (a `#page=N` sheet: the board IS one page, the fit's page frame) */
  ref: BoardBox
}

/** the drawing at (x, y), or null outside every drawing */
export const drawingAt = (drawings: readonly SheetDrawing[], x: number, y: number): SheetDrawing | null =>
  drawings.find(({ clip: [x0, y0, x1, y1] }) => x >= x0 && x <= x1 && y >= y0 && y <= y1) ?? null

/**
 * The pack's ONE map fit is measured on the reference drawing, so on a sheet with storey drawings
 * every point reaches the ground through the drawing it is in (owner, 19.11.2026: a «F» in the 2OG
 * drawing stood in the street): `onReference` lays a board point onto the reference drawing – into
 * its page's coordinates, plus the drawing's join shift (a page-coordinate thing), back onto the
 * board where the reference page lies – the same building point; `offReference` puts a
 * reference point back into drawing `d`. A point outside every drawing is paper, not building,
 * and stays as it is; so does every point of a sheet without drawings. Used by the bake and the
 * projection (tacticalObjects · bakeGeoBody / annoAfterMapEdit, planProjection · projectOnto)
 * through `PlanFit.drawings`.
 */
export function onReference(drawings: readonly SheetDrawing[] | undefined, p: PlanPt): PlanPt {
  const d = drawings?.length ? drawingAt(drawings, p.x, p.y) : null
  if (!d) return p
  const { page, ref, shift } = d
  return {
    x: ref.left + ((p.x - page.left) / page.width + shift[0]) * ref.width,
    y: ref.top + ((p.y - page.top) / page.height + shift[1]) * ref.height,
  }
}
export function offReference(q: PlanPt, d: SheetDrawing | null | undefined): PlanPt {
  if (!d) return q
  const { page, ref, shift } = d
  return {
    x: page.left + ((q.x - ref.left) / ref.width - shift[0]) * page.width,
    y: page.top + ((q.y - ref.top) / ref.height - shift[1]) * page.height,
  }
}

/** The drawing a ground point of storey `storey` lands in on such a sheet: that storey's drawing –
 *  of a storey drawn as wings, the one whose rectangle holds the point, else the first. Without a
 *  storey, or one the sheet has no drawing for: none – the reference drawing's frame as it is. */
export function storeyDrawing(drawings: readonly SheetDrawing[] | undefined, storey: number | null | undefined, q: PlanPt): SheetDrawing | undefined {
  const own = storey == null ? [] : (drawings ?? []).filter((d) => d.storey === storey)
  return own.find((d) => { const p = offReference(q, d); return drawingAt([d], p.x, p.y) }) ?? own[0]
}
