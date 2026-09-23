/**
 * The vertex rules of a Linie and a Fläche, once, for both drawing surfaces (23.09.2026).
 *
 * The Karte (lib/useMapDrawing, lng/lat pairs) and the Plan (components/Whiteboard, sheet
 * fractions with an optional third element — the storey a vertex is on) edit the same kind of
 * polyline, and each answered «how few points may this shape keep?» and «where does a new node
 * go?» inline — five copies of `kind === 'area' ? 3 : 2`, a dozen of the draft thresholds, three
 * ways of splicing a point in. One module, so the two surfaces cannot drift apart on what a
 * drawable shape is.
 *
 * Generic over the point tuple: whatever a point carries past x/y (a plan vertex's floor) is
 * passed through untouched — these functions only ever place, drop or copy WHOLE points.
 */

/** A Fläche needs three points to enclose anything; everything else drawn by vertices — a Karte
 *  `line`, a Plan `draw` — needs two. The same number gates a draft's ✓, the tap-away
 *  auto-commit, the load gate (lib/workspace · isBoardAnno) and a node delete. */
export const minPoints = (kind: string): number => (kind === 'area' ? 3 : 2)

/** May one more vertex go without leaving a shape that can no longer be drawn? */
export const canDropVertex = (kind: string, count: number): boolean => count > minPoints(kind)

/** The same points with vertex `i` replaced by `p` (a node dragged, an end docked). */
export const replaceVertex = <P extends readonly number[]>(pts: readonly P[], i: number, p: P): P[] =>
  pts.map((q, j) => (j === i ? p : q))

/** The same points with `p` inserted so that it BECOMES index `index` (0 prepends, `length`
 *  appends). ⚠️ Callers differ in what they count from: the Karte's «+» hands the insert index
 *  itself, the Plan's «+» the index of the segment's first vertex — so it passes `idx + 1`. */
export const insertAt = <P extends readonly number[]>(pts: readonly P[], index: number, p: P): P[] =>
  [...pts.slice(0, index), p, ...pts.slice(index)]

/** The same points without vertex `i`. Enforcing the minimum is the caller's (canDropVertex): a
 *  draft may be deleted all the way down, a committed shape may not. */
export const removeVertex = <P extends readonly number[]>(pts: readonly P[], i: number): P[] =>
  pts.filter((_, j) => j !== i)

/** Grow an open line past one of its ends — «Verlängern», the staircase climb. */
export const extendEnd = <P extends readonly number[]>(pts: readonly P[], end: 'start' | 'end', p: P): P[] =>
  end === 'start' ? [p, ...pts] : [...pts, p]

/** The midpoint of segment `i` (vertex i → i + 1), wrapping to vertex 0 for the closing edge of
 *  a ring. Only x/y: the caller decides which storey the new node lands on. */
export const segmentMid = (pts: readonly (readonly number[])[], i: number): [number, number] => {
  const a = pts[i], b = pts[(i + 1) % pts.length]
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
