/**
 * The geometry the selection bar needs, once, for both drawing surfaces (components/SelectionBar).
 *
 * The two surfaces work in different frames — the Lage in lng/lat, the Plan in fractions of the
 * sheet — and used to answer «where is the middle of this?» in three different places: the map's
 * rotate knob off a coordinate centroid, the plan's off a `.wb-anno` chip's bounding box (which a
 * line, a Fläche and an Absperrkreis do not have at all), and each surface's group pill off its
 * own inline sum. One resolver, and a turn that both frames can describe, replaces all of them.
 */

/** Plain arithmetic mean of the points that define a selection. Null for an empty selection. */
export function centroid(pts: readonly (readonly [number, number])[]): [number, number] | null {
  if (!pts.length) return null
  let sx = 0, sy = 0
  for (const [x, y] of pts) { sx += x; sy += y }
  return [sx / pts.length, sy / pts.length]
}

interface RotateOpts {
  /** How many y-units one x-unit spans, so the turn stays rigid in a frame whose axes are not the
   *  same size: the map passes cos(latitude) (a degree of longitude is shorter than one of
   *  latitude), the plan the board's width/height ratio (x and y are fractions of different
   *  edges). 1 for a plain square frame. */
  xScale?: number
  /** The frame's y grows UPWARD (latitude) rather than downward (screen/board px). A clockwise
   *  turn on screen is then a negative turn in the frame's own maths. */
  yUp?: boolean
}

/** Turn `p` around `c` by `deg`, clockwise as the operator sees it on screen. */
export function rotateAround(
  p: readonly [number, number],
  c: readonly [number, number],
  deg: number,
  { xScale = 1, yUp = false }: RotateOpts = {},
): [number, number] {
  const sx = xScale || 1
  const rad = ((yUp ? -deg : deg) * Math.PI) / 180
  const cs = Math.cos(rad), sn = Math.sin(rad)
  const dx = (p[0] - c[0]) * sx, dy = p[1] - c[1]
  return [c[0] + (dx * cs - dy * sn) / sx, c[1] + (dx * sn + dy * cs)]
}

/** A stored bearing plus a turn, normalised to 0–359 whole degrees (what every `rotation` /
 *  `rotation2` field in the app holds).
 *  ⚠️ Rounded BEFORE the wrap, not after: a fraction just below zero normalises to 359.6, which
 *  then rounds to 360 — a value outside the range this is supposed to guarantee. */
export const turnedBy = (deg: number, by: number) => ((Math.round(deg + by) % 360) + 360) % 360

/**
 * One frame of a transform on a GEOREFERENZ TWIN — the one selection whose geometry lives in a
 * different frame from the finger moving it.
 *
 * The mirror is dragged where it is seen, but the write lands on the ONE source object in the
 * source's own frame. So the point is taken INTO the gesture's frame, turned about the centre the
 * operator sees, translated by the delta they made, and handed BACK. The two surfaces pass the
 * two directions of the same fit (`toMap`/`toPlan`) — which is `into` and which is `back` is the
 * whole difference between them, and it is why this is one function rather than two.
 */
export function transformThroughFit(
  p: readonly [number, number],
  into: (p: readonly [number, number]) => [number, number],
  back: (p: readonly [number, number]) => [number, number],
  t: { dx: number; dy: number; deg: number },
  centre: readonly [number, number] | null,
  opts: RotateOpts = {},
): [number, number] {
  const q = into(p)
  const r = t.deg && centre ? rotateAround(q, centre, t.deg, opts) : q
  return back([r[0] + t.dx, r[1] + t.dy])
}
