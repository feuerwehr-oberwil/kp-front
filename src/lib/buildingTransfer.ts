import { buildView, fpBoxFrac, type Pt, type Ring } from './footprint'
import { TILE_AR } from './whiteboard'
import type { BoardAnno, BoardPoint, BuildingDoc, LngLat, SrcGeoref } from '../types'

export type { SrcGeoref }

/**
 * Re-anchoring floor-stack annotations when the BUILDING underneath them changes — and finding a
 * saved building again among the live OSM footprints.
 *
 * Why this exists
 * ---------------
 * A `BuildingDoc` normalises its footprints to their COMBINED bounding box (uniformly, by the
 * larger side) and the floor-stack annotations in `board['gebaeude']` are stored in the TILE space
 * that box produces. So the moment the picked ring set changes — a Nebengebäude added, a wrong
 * footprint dropped — the box and `principalAngleDeg` change with it, and every stored coordinate
 * silently comes to mean a different place on the ground. The Brandherd in the north-east corner
 * does not move on screen; it just stops being where the fire is. That is a tactical picture going
 * quietly wrong on the surface an Atemschutztrupp is placed on, which is why carrying the stack
 * over unchanged is never an option.
 *
 * What this does
 * --------------
 * Carries a point from the old building's tile space to the new one THROUGH THE GROUND, so a
 * drawing keeps its world position rather than its rectangle position. The chain mirrors
 * `footprint · remapPoint` (which does the same for a re-orientation of ONE building) with the
 * world hop inserted where the two `src` frames meet:
 *
 *   tile(old) → footprint-local → src(old) → ground metres → src(new) → footprint-local → tile(new)
 *
 * Everything but the middle step comes from `lib/footprint`, so the two stay in lockstep — the
 * test pins this chain against `remapPoint` for the case they must agree on.
 *
 * Ground frame: a local equirectangular metre frame, which is the EXACT inverse of the projection
 * `OsmOutline` uses to build picker space (a square metre-bbox around the incident). LV95 would be
 * the more precise frame in principle, but its grid north is not the frame `src` was built in, so
 * converting through it would introduce a rotation this maths does not have.
 *
 * What it needs, and what happens without it
 * ------------------------------------------
 * All of this rides on `BuildingDoc.geo` (`SrcGeoref`, recorded at pick time). A building saved
 * before that field existed has none, cannot be placed on the ground, and therefore takes the
 * LEGACY path: its markings are dropped, counted and named, exactly as before. Never guessed.
 */

/** metres per degree of latitude — the same constant `OsmOutline` projects its bbox with */
export const M_PER_LAT = 110540
/** metres per degree of longitude at this latitude */
export const mPerLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180)

/** A building as this transform needs to see it: its footprints, the view its annotations were
 *  stored in, where it sits on the ground, and how many storeys share the board. */
export interface BuildingFrame {
  src: Ring[]
  /** the ACTIVE view angle (0 while «Norden oben») — annotations live in this view's tiles */
  angleDeg: number
  geo: SrcGeoref
  /** storeys in the stack: the footprint box is fitted into ONE band of the board, so the
   *  tile↔box affine depends on how many bands there are. */
  floors: number
}

/** The georeference of a freshly picked footprint set, from the picker's own square metre-bbox.
 *  `picked` are rings in picker space (0..1 of a ±`radiusM` square around `center`), i.e. exactly
 *  what `OsmOutline` holds before it normalises them into `src`. */
export function georefFromPick(center: LngLat, radiusM: number, picked: Ring[]): SrcGeoref {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of picked) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const sideM = 2 * radiusM // the picker bbox is a metre-SQUARE, so one picker unit = sideM metres
  const span = Math.max(maxX - minX, maxY - minY) || 1
  // picker (0.5, 0.5) is the incident centre; x runs east, y runs south
  const eastM = (minX - 0.5) * sideM
  const southM = (minY - 0.5) * sideM
  return {
    origin: [center[0] + eastM / mPerLon(center[1]), center[1] - southM / M_PER_LAT],
    spanM: span * sideM,
  }
}

/** A `src`-space point back into the PICKER space of a given bbox — the exact inverse of
 *  `georefFromPick` when `center`/`radiusM` are the same square, which is what lets a saved
 *  building be laid back over the live Overpass footprints. */
export function srcToPicker(geo: SrcGeoref, center: LngLat, radiusM: number, [x, y]: Pt): Pt {
  const sideM = 2 * radiusM
  // the same reference latitude `georefFromPick` used, so the round-trip is exact rather than
  // merely close — a half-metre of drift here would be enough to mis-hit a narrow Reihenhaus
  const eastM = (geo.origin[0] - center[0]) * mPerLon(center[1]) + x * geo.spanM
  const southM = (center[1] - geo.origin[1]) * M_PER_LAT + y * geo.spanM
  return [0.5 + eastM / sideM, 0.5 + southM / sideM]
}

/** A `src`-space point carried from one building's frame to another's through ground metres. */
export function srcAcrossGround(from: SrcGeoref, to: SrcGeoref, [x, y]: Pt): Pt {
  const lat = (from.origin[1] + to.origin[1]) / 2
  // how far the NEW origin sits east / south of the OLD one
  const eastM = (to.origin[0] - from.origin[0]) * mPerLon(lat)
  const southM = (from.origin[1] - to.origin[1]) * M_PER_LAT
  return [(x * from.spanM - eastM) / to.spanM, (y * from.spanM - southM) / to.spanM]
}

/**
 * An annotation point (tile 0..1 of the OLD stack) → the same ground position in the NEW stack's
 * tile space, or `null` when that ground position is not on the new sheet at all.
 *
 * ⚠️ `null` means DROPPED, never clamped. Clamping to the edge would assert a position that is
 * false — an Atemschutztrupp pinned to a wall it is not at reads as knowledge, not as a guess.
 * The caller counts the nulls and names them before committing (see the replace confirm), and the
 * whole change rides the existing confirm-with-undo, so a drop is always one tap from restored.
 */
export function remapAcrossBuildings(
  from: BuildingFrame,
  to: BuildingFrame,
  layout: { boardW: number; boardH: number },
  p: Pt,
): Pt | null {
  const vFrom = buildView(from.src, from.angleDeg)
  const vTo = buildView(to.src, to.angleDeg)
  const a = fpBoxFrac(vFrom.aspect, layout.boardW, layout.boardH, from.floors)
  const b = fpBoxFrac(vTo.aspect, layout.boardW, layout.boardH, to.floors)
  // tile → footprint-local: the inverse of the centred box `fpBoxFrac` describes. Duplicated from
  // footprint.ts (where it is private); the parity test against `remapPoint` is what keeps the two
  // honest if that box math ever moves.
  const local: Pt = [(p[0] - (0.5 - a.rw / 2)) / a.rw, (p[1] - (0.5 - a.rh / 2)) / a.rh]
  const ground = srcAcrossGround(from.geo, to.geo, vFrom.fromNorm(local))
  const local2 = vTo.toNorm(ground)
  const t: Pt = [0.5 - b.rw / 2 + local2[0] * b.rw, 0.5 - b.rh / 2 + local2[1] * b.rh]
  return t[0] < 0 || t[0] > 1 || t[1] < 0 || t[1] > 1 ? null : t
}

// ---- finding a saved building among the live footprints ------------------------------

/** How far two footprints' centres may sit apart — as a share of the larger one's extent — and
 *  still be the same building. Tight on purpose: a wrong match would pre-select the neighbour's
 *  house, and «Übernehmen» would then re-anchor the stack onto it. */
const MATCH_TOL = 0.35
/** …and how differently sized they may be. An OSM edit redraws a footprint; it does not double it. */
const MATCH_SIZE = 2

function centroidExtent(ring: Ring): { c: Pt; extent: number } {
  let sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of ring) {
    sx += x; sy += y
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const n = ring.length || 1
  return { c: [sx / n, sy / n], extent: Math.max(maxX - minX, maxY - minY) }
}

/**
 * Which of the LIVE Overpass footprints are the ones this building was built from.
 *
 * Matched BY WORLD POSITION — the saved rings are projected back into the picker's own bbox via
 * `geo` and compared where they lie. Two alternatives were considered and rejected:
 *   • matching by normalised SHAPE is scale-ambiguous by construction (`src` is normalised to the
 *     combined bbox, so a house and its double are the same ring);
 *   • matching by OSM way/relation id is impossible — none is kept anywhere in the record.
 *
 * `missing` counts saved rings with no live counterpart (offline fallback, a moved bbox, an OSM
 * edit). Those are NOT silently dropped from the selection — the picker says so, because applying
 * would lose them.
 */
export function matchStoredRings(
  stored: Ring[],
  geo: SrcGeoref,
  center: LngLat,
  radiusM: number,
  live: Ring[],
): { indices: number[]; missing: number } {
  const want = stored.map((ring) => centroidExtent(ring.map((p) => srcToPicker(geo, center, radiusM, p))))
  const have = live.map(centroidExtent)
  const used = new Set<number>()
  const indices: number[] = []
  let missing = 0
  for (const w of want) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < have.length; i++) {
      if (used.has(i)) continue
      const h = have[i]
      const scale = Math.max(w.extent, h.extent) || 1
      const ratio = w.extent && h.extent ? Math.max(w.extent / h.extent, h.extent / w.extent) : Infinity
      if (ratio > MATCH_SIZE) continue
      const d = Math.hypot(w.c[0] - h.c[0], w.c[1] - h.c[1]) / scale
      if (d <= MATCH_TOL && d < bestD) { bestD = d; best = i }
    }
    if (best < 0) { missing++; continue }
    used.add(best)
    indices.push(best)
  }
  return { indices: indices.sort((a, b) => a - b), missing }
}

// ---- the whole floor stack across a building change ----------------------------------

/** The board the floor stack is drawn on. Only the TILE aspect matters to `fpBoxFrac`, and in
 *  stack mode the board's aspect is `floors × TILE_AR` by construction (Whiteboard · effAspect) —
 *  so one tile is `TILE_AR` regardless of pixel size or storey count, and the re-anchoring needs
 *  no measured layout from the DOM. `reportPdfDirect` renders the stack off the same identity. */
const stackLayout = (floors: number) => ({ boardW: 1, boardH: floors * TILE_AR })

/** Every floor-stack annotation carried from one building frame to the next, plus how many could
 *  not be. Pure — the caller owns the confirm, the toast and the undo. */
export function remapBoardAnnos(
  from: BuildingFrame,
  to: BuildingFrame,
  layout: { boardW: number; boardH: number },
  annos: BoardAnno[],
): { annos: BoardAnno[]; dropped: number } {
  const mv = (p: Pt) => remapAcrossBuildings(from, to, layout, p)
  const kept: BoardAnno[] = []
  const gone = new Set<string>()
  for (const a of annos) {
    const next: BoardAnno = { ...a }
    let ok = true
    if (a.x != null && a.y != null) {
      const m = mv([a.x, a.y])
      if (!m) ok = false
      else { next.x = m[0]; next.y = m[1] }
    }
    if (ok && a.pts) {
      // ⚠️ A polygon or a Leitung is an ASSERTION about a shape: keeping the vertices that still
      // fit would draw a line the operator never drew. All of it or none of it.
      const pts: BoardPoint[] = []
      for (const p of a.pts) {
        const m = mv([p[0], p[1]])
        if (!m) { ok = false; break }
        pts.push(p[2] == null ? [m[0], m[1]] : [m[0], m[1], p[2]])
      }
      if (ok) next.pts = pts
    }
    if (!ok) { gone.add(a.id); continue }
    // A trail is a SAMPLED path, not an assertion about a shape — a sample whose ground position
    // is off the new sheet simply has no place on it, and leaving it out does not take the
    // annotation with it.
    if (a.trail) next.trail = a.trail.flatMap((tp) => {
      const m = mv([tp.x, tp.y])
      return m ? [{ ...tp, x: m[0], y: m[1] }] : []
    })
    kept.push(next)
  }
  // a magnetic line anchored to something that did not come along must let go of it, or it points
  // at an id that is no longer on the board (same rule as removing a storey)
  const annosOut = gone.size === 0 ? kept : kept.map((a) => ({
    ...a,
    ...(a.startAttachment && gone.has(a.startAttachment.target.id) ? { startAttachment: undefined } : {}),
    ...(a.endAttachment && gone.has(a.endAttachment.target.id) ? { endAttachment: undefined } : {}),
  }))
  return { annos: annosOut, dropped: gone.size }
}

/** A freshly picked footprint set, as `OsmOutline` hands it up. */
export interface BuildingPick {
  src: Ring[]
  orientDeg: number
  geo: SrcGeoref
}

export interface BuildingAmend {
  /** the storeys the new stack has — INHERITED from the old building, because otherwise every
   *  annotation above the ground floor is homeless the moment the new stack starts at `[0]` */
  floors: number[]
  /** the old stack's annotations, re-anchored into the new building's tile space */
  annos: BoardAnno[]
  /** how many kept their place on the ground */
  carried: number
  /** how many were dropped — their ground position is not on the new sheet */
  dropped: number
  /** the old building carries no georeference (picked before the field existed), so nothing can
   *  be anchored: the markings go, counted and named, exactly as they did before this shipped */
  legacy: boolean
}

/**
 * Replacing or amending the building under an existing floor stack.
 *
 * The one decision this encodes: a drawing must keep the spot it marks ON THE EARTH, never the
 * spot it happened to occupy in the old rectangle. Anything that cannot be placed on the new
 * sheet is dropped and counted — never clamped, never guessed.
 */
export function amendBuilding(
  prev: BuildingDoc | null,
  next: BuildingPick,
  annos: BoardAnno[],
): BuildingAmend {
  if (!prev) return { floors: [0], annos: [], carried: 0, dropped: 0, legacy: false }
  const src = prev.src as Ring[] | undefined
  if (!prev.geo || !src?.length) {
    return { floors: [0], annos: [], carried: 0, dropped: annos.length, legacy: true }
  }
  const floors = prev.floors.length ? prev.floors : [0]
  const layout = stackLayout(floors.length)
  const from: BuildingFrame = {
    src, angleDeg: prev.northUp ? 0 : (prev.orientDeg ?? 0), geo: prev.geo, floors: floors.length,
  }
  // a fresh pick is always stored ORIENTED (northUp: false), so its active view is `orientDeg`
  const to: BuildingFrame = { src: next.src, angleDeg: next.orientDeg, geo: next.geo, floors: floors.length }
  const out = remapBoardAnnos(from, to, layout, annos)
  return { floors, annos: out.annos, carried: out.annos.length, dropped: out.dropped, legacy: false }
}
