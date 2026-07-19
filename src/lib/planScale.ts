/** Per-plan distance calibration for the Plan whiteboard.
 *
 *  A plan sheet has no inherent geo scale, so the user calibrates against a reference of
 *  known real length — typically a printed scale bar: drag a segment along it, enter its
 *  metres, and we derive a factor for THAT plan.
 *
 *  Plan annotation points are normalized 0..1 in the plan's document box, and that box is
 *  NOT square — x is a fraction of width, y a fraction of height — so a raw normalized
 *  length is not a real length. We aspect-correct with the plan's aspect ratio
 *  `ar = width / height` (in intrinsic px): the "aspect-corrected unit length" of a
 *  normalized segment is
 *
 *      U = hypot(dnx * ar, dny)
 *
 *  which is proportional to the true pixel (hence physical) length. The stored factor
 *  `mPerU` is metres per such unit; real length = mPerU * U. Calibration is the inverse:
 *  `mPerU = refMetres / U(reference)`. Because the normalized coords are zoom-independent,
 *  one calibration stays valid across pan/zoom — and across every storey of a floor-stack
 *  building (same drawing, same scale), so it's calibrated once per plan.
 */
export type NPoint = [number, number]

export interface PlanScale {
  /** metres per aspect-corrected normalized unit (see module doc). */
  mPerU: number
  /** the reference length the user entered, in metres — backs the trust chip / re-calibrate. */
  refM: number
  /** aspect ratio (width / height) the factor was derived at; if the plan's current aspect
   *  differs the factor is stale (image replaced / re-sized) and the caller should warn. */
  ar: number
}

/** Aspect-corrected length of one normalized segment (unitless; multiply by mPerU for metres). */
export function unitLen(a: NPoint, b: NPoint, ar: number): number {
  return Math.hypot((b[0] - a[0]) * ar, b[1] - a[1])
}

/** Total aspect-corrected length of a normalized polyline. */
export function pathUnits(pts: NPoint[], ar: number): number {
  let u = 0
  for (let i = 1; i < pts.length; i++) u += unitLen(pts[i - 1], pts[i], ar)
  return u
}

/** Derive a calibration from a reference segment of known real length. Returns null if the
 *  reference is degenerate (zero length / non-positive metres) — the caller keeps the old factor. */
export function calibrate(a: NPoint, b: NPoint, refM: number, ar: number): PlanScale | null {
  const u = unitLen(a, b, ar)
  if (!(u > 0) || !(refM > 0) || !(ar > 0)) return null
  return { mPerU: refM / u, refM, ar }
}

/** Real-world length of a normalized polyline in metres under a calibration factor. */
export function pathMetres(pts: NPoint[], mPerU: number, ar: number): number {
  return pathUnits(pts, ar) * mPerU
}

/** Real-world area (m²) of a normalized polygon under a calibration factor. Aspect-correct:
 *  measure-space coords are (nx·ar, ny), so the real area = mPerU² · ar · |normalized shoelace|. */
export function polyAreaM2(pts: NPoint[], mPerU: number, ar: number): number {
  if (pts.length < 3) return 0
  let cross = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    cross += x1 * y2 - x2 * y1
  }
  return (Math.abs(cross) / 2) * ar * mPerU * mPerU
}

/** Is a stored calibration stale for the plan's current aspect ratio? (image replaced / resized) */
export function isStale(scale: PlanScale, ar: number): boolean {
  if (!(scale.ar > 0) || !(ar > 0)) return false
  return Math.abs(scale.ar - ar) / scale.ar > 0.02 // >2% aspect drift = the sheet changed under it
}
