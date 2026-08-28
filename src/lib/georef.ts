/** Map ⇄ Plan georeferencing: landmark point-pairs → a similarity transform per plan.
 *
 *  The operator taps the SAME landmark twice — once on the plan sheet (a house corner, a
 *  hydrant, a path junction), once on the map. Two such pairs already pin the sheet onto the
 *  world: a similarity transform (translation + rotation + one uniform scale, no shear, no
 *  mirroring) is exactly what relates a north-arbitrary printed plan to the map, and it has
 *  four degrees of freedom — two pairs supply four equations. Every further pair is redundant
 *  and therefore useful: it is what finally lets us state an honest residual.
 *
 *  ## Coordinate spaces
 *
 *  - **Plan** — normalized `{x, y}` in 0..1 of the plan's document box, x a fraction of width,
 *    y a fraction of height, y running DOWN. Same space `BoardAnno.x/y` and `pts` live in, so
 *    a stored annotation is a valid `planPt` without conversion. Because that box is not
 *    square, a normalized length is not a real length — every fit is therefore taken at a
 *    `planAspect` (= board width / height in intrinsic px, the `measureAR` of usePlanMeasure)
 *    which turns plan coords into the isotropic "unit" space `(x·ar, y)`.
 *  - **Map** — `{lng, lat}` WGS84 objects, NOT the `LngLat` tuple. Named fields because the
 *    pairs are persisted as JSON and because a MapLibre click hands over `e.lngLat` in exactly
 *    this shape; a swapped tuple is the classic silent bug here.
 *  - **Metres** — internally the fit runs in latitude-corrected Web-Mercator metres (see
 *    `project`). That correction is what makes `residuals` honest metres instead of Mercator
 *    metres, which at 47° N are ~47 % too long.
 *
 *  The math itself is space-agnostic: it only requires that the pairs and every point later
 *  transformed live in the SAME plan space at the SAME aspect. A floor-stack board (whose
 *  annotations are re-normalized per storey TILE) may therefore be georeferenced tile-locally
 *  by passing tile-local pairs and the tile aspect — as long as the caller stays consistent.
 *
 *  Storage lives beside the plan calibration: see `stationGeoref` helpers in
 *  src/lib/stationPlanScale.ts and backend app/api/plan_scales.py.
 */

/** Normalized plan point, 0..1 of the document box, y down (mirrors `BoardAnno.x/y`). */
export interface PlanPt {
  x: number
  y: number
}

/** WGS84 position as named fields — the shape MapLibre's `e.lngLat` already has. */
export interface GeoPt {
  lng: number
  lat: number
}

/** One landmark, seen on both surfaces.
 *
 *  `kind` records HOW the pair came to be: 'gesetzt' when it was placed as a new reference,
 *  'korrigiert' when an existing cross was re-tapped to fix the error the operator could see.
 *  It carries no weight in the fit — it exists so the UI can say which pairs were adjusted. */
export interface GeorefPair {
  plan: PlanPt
  lngLat: GeoPt
  kind?: 'gesetzt' | 'korrigiert'
}

/** The stored georeference of one plan. An object rather than a bare array so the document can
 *  grow a field later without a migration (old blobs already validate). */
export interface Georef {
  pairs: GeorefPair[]
}

/** A solved transform plus everything needed to judge whether to trust it. */
export interface GeorefFit {
  /** plan (normalized, y down) → map */
  toMap(planPt: PlanPt): GeoPt
  /** map → plan (normalized, y down); may fall outside 0..1 when the point is off the sheet */
  toPlan(lngLat: GeoPt): PlanPt
  /** metres per aspect-corrected normalized unit — the SAME unit as `PlanScale.mPerU`, so a
   *  georeferenced plan is also a calibrated one (see planScale.ts · unitLen). */
  scaleMPerU: number
  /** rotation of the fit in degrees, counter-clockwise, in the math sense. Plan-up points at
   *  compass bearing `-rotationDeg` — a plan drawn north-up on a north-up map fits at ~0. */
  rotationDeg: number
  /** number of pairs the fit was solved from */
  n: number
  /** per-pair distance between the fitted position and the tapped map position, in metres,
   *  in the order the pairs were given. All zero (to float precision) at n === 2. */
  residuals: number[]
  /** RMS of `residuals` — the "⌀ x m" a UI chip shows. Root-mean-square, not the arithmetic
   *  mean, so a single bad pair stays visible instead of being averaged away.
   *  ⚠️ Meaningless at n === 2 (two pairs always solve exactly) — go through `residualClaim`. */
  meanResidualM: number
  /** the worst single residual, in metres — which pair to go fix */
  maxResidualM: number
  /** the largest distance between any two reference points, in metres. Short baseline = every
   *  tapping error is levered up across the sheet (see BASELINE_WARN_M). */
  baselineM: number
  /** are the reference points (near-)collinear? Only meaningful from 3 pairs on. ⚠️ NOT because
   *  the transform would be ill-determined — a similarity has four degrees of freedom and two
   *  distinct points already fix all four exactly, so a third point on the same line takes
   *  nothing away. What collinearity costs is the RESIDUALS: an error the similarity cannot
   *  absorb — a wrong `planAspect` above all — moves the sheet PERPENDICULAR to the reference
   *  line, and there is no reference out there to disagree with it. So the sheet can sit visibly
   *  skewed while «⌀ 0.0 m» stands, which is exactly the reading a quality chip must not give. */
  collinear: boolean
  /** ratio of the minor to the major principal axis of the plan points (0 = a perfect line,
   *  1 = perfectly spread). null under 3 pairs, where it says nothing. */
  axisRatio: number | null
}

/** Below this the reference points sit too close together to carry the sheet: at a 20 m
 *  baseline a 1 m tapping error is already a 3° rotation error, which throws a symbol 50 m away
 *  by 2.5 m. The UI warns; it does not block — a small courtyard plan has nothing further apart. */
export const BASELINE_WARN_M = 20

/** Minor/major axis ratio under which the reference points count as collinear. 0.08 ≈ points
 *  scattered no more than ~8 % of their spread off a straight line (the prototype's threshold). */
export const COLLINEAR_AXIS_RATIO = 0.08

/** How close two plan points must be to count as the SAME landmark, in normalized units —
 *  0.2 % of the sheet (≈3.6 px on a 1819 px plan), comfortably under a fingertip but far below
 *  the distance any two useful references have. See `replacePair`. */
export const PAIR_EPS_N = 0.002

/** Are these two plan points the SAME landmark? The one place that question is answered, so
 *  «re-tapping corrects instead of appending» (`replacePair`), «this drag would land on top of a
 *  neighbour» (georefMode · dragPlan) and «these references carry no sheet» (`fitSimilarity`)
 *  cannot drift apart. */
export function samePlanPt(a: PlanPt, b: PlanPt, eps = PAIR_EPS_N): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps
}

// --- projection ---------------------------------------------------------------------------
// Web-Mercator metres, scaled by cos(lat0). Mercator metres are inflated by 1/cos(lat), so
// undoing that at the plan's own latitude yields (to well under a per-mille over a plan-sized
// extent) true ground metres — which is the only reason a residual may be printed as "m".
// mapView.ts projects the same way for screen pixels; this is the metric twin of `worldPx`.

const R_EARTH = 6378137 // WGS84 semi-major axis (m) — the Web-Mercator sphere radius
const DEG = Math.PI / 180

interface Metre {
  x: number
  y: number
}

/** Projector fixed at one reference latitude, so forward and inverse always agree. */
function projector(lat0: number) {
  const k = Math.cos(lat0 * DEG) * R_EARTH
  return {
    project: (p: GeoPt): Metre => ({
      x: k * p.lng * DEG,
      y: k * Math.log(Math.tan(Math.PI / 4 + p.lat * DEG / 2)),
    }),
    unproject: (m: Metre): GeoPt => ({
      lng: m.x / k / DEG,
      lat: (2 * Math.atan(Math.exp(m.y / k)) - Math.PI / 2) / DEG,
    }),
  }
}

// --- the fit ------------------------------------------------------------------------------

/**
 * Solve the similarity transform (Umeyama, closed form) that carries plan points onto the map.
 *
 * Plan x runs right and y runs DOWN, projected metres run east and NORTH, so the plan y axis is
 * flipped into the fit's working space; after that rotation + uniform scale suffice and no
 * mirroring can creep in — which matters, because a mirrored "fit" would look plausible on a
 * symmetric building and put every symbol on the wrong side of it.
 *
 *   centroids cp, cm  →  centred a_i, b_i
 *   dot   = Σ (a·b),  cross = Σ (a×b)ᶻ,  den = Σ |a|²
 *   θ = atan2(cross, dot),  s = |(dot, cross)| / den,  t = cm − s·R(θ)·cp
 *
 * Returns null when there is nothing to solve: fewer than two pairs (one pair fixes only the
 * translation — scale and north stay unknown, and this app has no nominal plan scale to assume),
 * plan points that do not spread further than `PAIR_EPS_N`, or map points on top of each other.
 *
 * @param planAspect board width / height in intrinsic px (the `measureAR` of usePlanMeasure)
 */
export function fitSimilarity(pairs: GeorefPair[], planAspect: number): GeorefFit | null {
  const n = pairs.length
  if (n < 2 || !(planAspect > 0)) return null

  // reference latitude = mean of the pairs, so the cos(lat) correction is right where the plan is
  const lat0 = pairs.reduce((s, p) => s + p.lngLat.lat, 0) / n
  const { project, unproject } = projector(lat0)

  const P = pairs.map((p) => ({ x: p.plan.x * planAspect, y: -p.plan.y })) // aspect-corrected, y up
  const M = pairs.map((p) => project(p.lngLat))
  const cp = centroid(P)
  const cm = centroid(M)

  let dot = 0, cross = 0, den = 0, sxx = 0, syy = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    const ax = P[i].x - cp.x, ay = P[i].y - cp.y
    const bx = M[i].x - cm.x, by = M[i].y - cm.y
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
    den += ax * ax + ay * ay
    sxx += ax * ax; syy += ay * ay; sxy += ax * ay
  }
  // ⚠️ The plan points have to actually SPREAD, and `den > 0` is not that test: it only catches
  // BIT-EXACT coincidence. Drag one cross to a tenth of a pixel from another and the solver still
  // "succeeds" — with a scale around 1e9 m per unit and residuals around 1e-7 m, which read as a
  // flawless fit, while a symbol at the sheet's centre lands near latitude −90. Nothing else here
  // bounds it either: `baselineM` is measured on the MAP side, which stays perfectly healthy, so
  // the warnings say only «aus 2 Punkten». Two plan points closer than PAIR_EPS_N are the SAME
  // landmark by this module's own definition (see `samePlanPt` / `replacePair`), and one landmark
  // carries no sheet.
  if (!(planSpread(pairs) >= PAIR_EPS_N)) return null
  // den ≈ 0 is now impossible for a sane aspect, but an extreme `planAspect` can still underflow
  // it — this is the numerical floor. hypot ≈ 0: every map point is the same point, so there is
  // no scale and no rotation to be had. Say so instead of returning a transform that divides by
  // zero the first time a symbol is mirrored back.
  if (!(den > 1e-18)) return null
  const th = Math.atan2(cross, dot)
  const s = Math.hypot(dot, cross) / den
  if (!(s > 0) || !Number.isFinite(s)) return null

  const cos = Math.cos(th), sin = Math.sin(th)
  const t = {
    x: cm.x - s * (cos * cp.x - sin * cp.y),
    y: cm.y - s * (sin * cp.x + cos * cp.y),
  }
  const planToMetre = (p: PlanPt): Metre => {
    const x = p.x * planAspect, y = -p.y
    return { x: t.x + s * (cos * x - sin * y), y: t.y + s * (sin * x + cos * y) }
  }
  const metreToPlan = (m: Metre): PlanPt => {
    const dx = (m.x - t.x) / s, dy = (m.y - t.y) / s
    return { x: (cos * dx + sin * dy) / planAspect, y: sin * dx - cos * dy }
  }

  // residuals: where the fit puts each landmark vs. where it was tapped, in metres
  const residuals = pairs.map((p, i) => {
    const q = planToMetre(p.plan)
    return Math.hypot(q.x - M[i].x, q.y - M[i].y)
  })
  const meanResidualM = Math.sqrt(residuals.reduce((a, d) => a + d * d, 0) / n)
  const maxResidualM = residuals.reduce((a, d) => Math.max(a, d), 0)

  // baseline: the widest span the references actually cover, measured on the map side where the
  // metres are given rather than derived from the fit we are judging
  let baselineM = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) baselineM = Math.max(baselineM, Math.hypot(M[i].x - M[j].x, M[i].y - M[j].y))
  }

  // principal axes of the plan points: a minor axis near zero means they lie on a line. The fit
  // itself stays exact — but perpendicular to that line NOTHING was ever checked, so the residuals
  // go on reading zero however far the sheet is off (see `collinear`). Under three pairs the
  // question is not asked — two points are trivially a line and solve exactly anyway.
  let axisRatio: number | null = null
  if (n >= 3) {
    const tr = sxx + syy
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)))
    const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc)
    axisRatio = l1 > 0 ? Math.sqrt(l2 / l1) : 0
  }

  return {
    toMap: (planPt) => unproject(planToMetre(planPt)),
    toPlan: (lngLat) => metreToPlan(project(lngLat)),
    scaleMPerU: s,
    rotationDeg: (th * 180) / Math.PI,
    n,
    residuals,
    meanResidualM,
    maxResidualM,
    baselineM,
    collinear: axisRatio !== null && axisRatio < COLLINEAR_AXIS_RATIO,
    axisRatio,
  }
}

function centroid(pts: Metre[]): Metre {
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  }
}

/** Widest distance between any two reference points, in NORMALIZED plan units — the units
 *  `PAIR_EPS_N` is stated in, deliberately not the aspect-corrected ones, so «too close together
 *  to be two landmarks» means the same thing here as it does in `replacePair`. O(n²) on a handful
 *  of points. */
function planSpread(pairs: GeorefPair[]): number {
  let d = 0
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      d = Math.max(d, Math.hypot(pairs[i].plan.x - pairs[j].plan.x, pairs[i].plan.y - pairs[j].plan.y))
    }
  }
  return d
}

/**
 * The residual a UI is ALLOWED to claim, in metres — or null when there is none to claim.
 *
 * Two pairs always solve exactly: the residual is zero by construction and says nothing about
 * how well the sheet actually sits. Printing "⌀ 0.0 m" there would be the app's most confident
 * lie, so at n === 2 the surface says «aus 2 Punkten» instead and only a third pair earns a
 * number. Every surface that shows a quality read-out goes through this.
 */
export function residualClaim(fit: GeorefFit | null): number | null {
  if (!fit || fit.n < 3) return null
  return fit.meanResidualM
}

/**
 * Add a pair, or REPLACE the one already sitting on that plan point.
 *
 * A plan point can only have one counterpart — a second pair on the same landmark would
 * contradict itself and quietly drag the fit towards whichever tap was worse. So re-tapping a
 * reference corrects it, and the returned array never grows in that case. Returns a new array;
 * the input is untouched.
 */
export function replacePair(pairs: GeorefPair[], pair: GeorefPair, eps = PAIR_EPS_N): GeorefPair[] {
  const i = pairs.findIndex((p) => samePlanPt(p.plan, pair.plan, eps))
  if (i < 0) return [...pairs, pair]
  const next = [...pairs]
  next[i] = pair
  return next
}

// ── automatic re-matching of mismatched pair ORDER ─────────────────────────────────────────────

/** A fit this bad is not a fit — start looking for the assignment the operator actually meant. */
const REMATCH_BAD_M = 10
/** …and only adopt a candidate that lands at least this good, */
const REMATCH_GOOD_M = 3
/** at least this many times better than what stands, */
const REMATCH_FACTOR = 4
/** with every point finding a counterpart within this much under the trial transform. */
const REMATCH_TOL_M = 8

/**
 * Re-derive WHICH map mark belongs to WHICH plan mark when the two sides were marked in
 * different orders.
 *
 * The pairing mode deliberately lets the operator queue freely on either surface — mark three
 * corners on the sheet, then the same three on the map. Queue them in a DIFFERENT order and
 * every pair holds two different physical features: the numbers disagree, the least-squares fit
 * is garbage, and re-doing twelve points by hand is exactly the punishment the free queueing
 * exists to avoid. But the information is all there — the two point CLOUDS still have the same
 * shape — so this solves the correspondence instead of asking for it again:
 *
 *   base:   the two plan points farthest apart, tried against every ordered pair of map points
 *           (an exact two-point similarity each — n·(n−1) candidates);
 *   match:  under each trial transform, greedily pair every plan point with its nearest unused
 *           map point (globally, closest first), requiring every point to land within
 *           REMATCH_TOL_M;
 *   accept: the best full assignment only if its refitted residual is genuinely good AND far
 *           better than what stands — a bad-but-honest set of taps is left alone.
 *
 * Null when there is nothing to fix (n < 3, the current fit is fine, or no assignment clears
 * the bar). Each returned pair keeps its plan half's `kind` — the plan marks are the identity,
 * only their map counterparts are re-dealt.
 */
export function rematchPairs(pairs: GeorefPair[], planAspect: number): { pairs: GeorefPair[]; fit: GeorefFit } | null {
  const n = pairs.length
  if (n < 3) return null
  const current = fitSimilarity(pairs, planAspect)
  if (current && current.meanResidualM <= REMATCH_BAD_M) return null

  // the two plan points farthest apart carry the trial transform (longest lever = most stable)
  let bi = 0, bj = 1, bd = -1
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = (pairs[i].plan.x - pairs[j].plan.x) * planAspect
      const dy = pairs[i].plan.y - pairs[j].plan.y
      const d = dx * dx + dy * dy
      if (d > bd) { bd = d; bi = i; bj = j }
    }
  }

  let best: { pairs: GeorefPair[]; fit: GeorefFit } | null = null
  for (let k = 0; k < n; k++) {
    for (let l = 0; l < n; l++) {
      if (k === l) continue
      const base = fitSimilarity([
        { plan: pairs[bi].plan, lngLat: pairs[k].lngLat, kind: 'gesetzt' },
        { plan: pairs[bj].plan, lngLat: pairs[l].lngLat, kind: 'gesetzt' },
      ], planAspect)
      if (!base) continue
      // all plan↔map distances in metres under the trial transform, then greedy global matching
      const projected = pairs.map((p) => base.toPlan(p.lngLat))
      const cand: { i: number; m: number; d: number }[] = []
      for (let i = 0; i < n; i++) {
        for (let m = 0; m < n; m++) {
          const dx = (pairs[i].plan.x - projected[m].x) * planAspect
          const dy = pairs[i].plan.y - projected[m].y
          const d = Math.hypot(dx, dy) * base.scaleMPerU
          if (d <= REMATCH_TOL_M) cand.push({ i, m, d })
        }
      }
      cand.sort((a, b) => a.d - b.d)
      const planTaken = new Array<boolean>(n).fill(false)
      const mapTaken = new Array<boolean>(n).fill(false)
      const match = new Array<number>(n).fill(-1)
      let matched = 0
      for (const c of cand) {
        if (planTaken[c.i] || mapTaken[c.m]) continue
        planTaken[c.i] = true; mapTaken[c.m] = true; match[c.i] = c.m; matched++
      }
      if (matched < n) continue
      const permuted: GeorefPair[] = pairs.map((p, i) => ({ ...p, lngLat: pairs[match[i]].lngLat }))
      const fit = fitSimilarity(permuted, planAspect)
      if (!fit) continue
      if (!best || fit.meanResidualM < best.fit.meanResidualM) best = { pairs: permuted, fit }
    }
  }

  if (!best || best.fit.meanResidualM > REMATCH_GOOD_M) return null
  if (current && best.fit.meanResidualM > current.meanResidualM / REMATCH_FACTOR) return null
  if (best.pairs.every((p, i) => p.lngLat === pairs[i].lngLat)) return null
  return best
}
