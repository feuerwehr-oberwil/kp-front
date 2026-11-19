import type { PlanPt } from './georef'

/*
 * A floor pack's storey drawings as they lie on ONE sheet's board, and the point maps through
 * them – the leaf half of lib/floorPackBinding (which lays them: `sheetDrawings`). Kept apart and
 * free of runtime imports so the unified-object bake (lib/tacticalObjects, in the entry chunk) can map
 * through a drawing without pulling the pack code in with it.
 */

/** One storey drawing on a plain sheet that shows a floor pack's pages – Modul 6 with its storeys
 *  drawn side by side, or one storey per page: which drawing it is (storey + part, as `floorKey`),
 *  its rectangle in the BOARD's normalized coordinates, and – on a ONE-page sheet only – its join
 *  shift onto the reference drawing. */
export interface SheetDrawing {
  storey: number
  part: number
  clip: [number, number, number, number]
  /** `FloorPackTile.shift`: a point p of this drawing is the building point p + shift of the
   *  reference drawing – the one the pack's map fit is measured on. Only when the sheet shows ONE
   *  page (board = page). A stitched multi-page sheet has none: its pairs and its pages do not
   *  speak one frame yet, so its drawings give a storey on the sheet and nothing to the Karte
   *  (follow-up, docs/plans-and-buildings.md). */
  shift?: [number, number]
}

/** the drawing at (x, y), or null outside every drawing */
export const drawingAt = (drawings: readonly SheetDrawing[], x: number, y: number): SheetDrawing | null =>
  drawings.find(({ clip: [x0, y0, x1, y1] }) => x >= x0 && x <= x1 && y >= y0 && y <= y1) ?? null

/**
 * The pack's ONE map fit is measured on the reference drawing, so on a sheet with storey drawings
 * every point reaches the ground through the drawing it is in (owner, 19.11.2026: a «F» in the 2OG
 * drawing stood in the street): `onReference` lays a board point onto the reference drawing (plus
 * that drawing's join shift) – the same building point; `offReference` puts a reference point back
 * into drawing `d`'s frame. A point outside every drawing is paper, not building, and stays as it
 * is; so does every point of a sheet without (shifted) drawings. Used by the bake and the
 * projection (tacticalObjects · bakeGeoBody / annoAfterMapEdit, planProjection · projectOnto)
 * through `PlanFit.drawings` – the way back always through `inFrame`.
 */
export function onReference(drawings: readonly SheetDrawing[] | undefined, p: PlanPt): PlanPt {
  const [dx, dy] = shiftOf(drawings?.length ? drawingAt(drawings, p.x, p.y) : null)
  return { x: p.x + dx, y: p.y + dy }
}
export function offReference(q: PlanPt, d: SheetDrawing | null | undefined): PlanPt {
  const [dx, dy] = shiftOf(d)
  return { x: q.x - dx, y: q.y - dy }
}
const shiftOf = (d: SheetDrawing | null | undefined): readonly [number, number] => d?.shift ?? [0, 0]

/**
 * Reference point `q` said in drawing `d`'s frame (`undefined` = the reference frame itself: the
 * reference drawing, or paper) – but only if the bake reads that sheet point back in the SAME
 * frame, so `onReference` returns `q` (Sol review #703, S3). Otherwise `null`: the point lands in
 * another drawing (an adjacent one, or one nested in a whole-page drawing) and would bake back
 * somewhere else. Same frame = same shift, so the reference drawing and paper are one frame.
 */
export function inFrame(drawings: readonly SheetDrawing[], q: PlanPt, d: SheetDrawing | null | undefined): PlanPt | null {
  const p = offReference(q, d)
  const [ax, ay] = shiftOf(drawingAt(drawings, p.x, p.y))
  const [bx, by] = shiftOf(d)
  return ax === bx && ay === by ? p : null
}

/** The drawing a ground point of storey `storey` lands in on such a sheet: that storey's drawing –
 *  of a storey drawn as wings, the one that holds the point (`inFrame`), else the first. Without a
 *  storey, or one the sheet has no drawing for: none – the reference drawing's frame as it is. */
export function storeyDrawing(drawings: readonly SheetDrawing[], storey: number | null | undefined, q: PlanPt): SheetDrawing | undefined {
  const own = storey == null ? [] : drawings.filter((d) => d.storey === storey)
  return own.find((d) => inFrame(drawings, q, d)) ?? own[0]
}
