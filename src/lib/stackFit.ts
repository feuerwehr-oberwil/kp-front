import { TILE_AR } from './whiteboard'
import { activeViewDeg, buildView, fpBoxFrac, type Pt, type Ring } from './footprint'
import { M_PER_LAT, mPerLon } from './buildingTransfer'
import { fitSimilarity, type GeorefFit, type GeorefPair } from './georef'
import type { BoardAnno, BuildingDoc, SrcGeoref } from '../types'
import { directionalGlyph, directionalGlyph2 } from './planProjection'
import { turnedBy } from './selectionTransform'
import type { FloorPackTile } from './floorPackBinding'

/** Place a drawing in the common frame; never independently centre or fit each crop. The three
 *  corners are the whole PAGE's (0,0), (1,0), (0,1) in the tile box — `regionCorners` cuts the
 *  floor's own rectangle out of that placement. */
export function packPagePlacement(frame: [number, number, number, number], tile: FloorPackTile): [Pt, Pt, Pt] {
  const [fx0, fy0, fx1, fy1] = frame
  const fw = fx1 - fx0, fh = fy1 - fy0
  const o: Pt = [(tile.shift[0] - fx0) / fw, (tile.shift[1] - fy0) / fh]
  return [o, [o[0] + 1 / fw, o[1]], [o[0], o[1] + 1 / fh]]
}

/**
 * Where ONE REGION of a page lands, given the page's own placement: the region's three corners
 * in the same frame, `region` being [x0, y0, x1, y1] of the page.
 *
 * The storey tile rasterises its region ALONE (components/PdfViewport · planRegionUrl, so the
 * drawing gets the whole pixel budget instead of its share of a page raster), and this is where
 * that raster goes. An affine placement, so it holds for the pack's axis-aligned frame and for a
 * footprint stack's turned page alike; a whole page ([0, 0, 1, 1]) comes back unchanged.
 */
export function regionCorners(corners: [Pt, Pt, Pt], region: readonly [number, number, number, number]): [Pt, Pt, Pt] {
  const [o, px, py] = corners
  const [x0, y0, x1, y1] = region
  const ex: Pt = [px[0] - o[0], px[1] - o[1]]
  const ey: Pt = [py[0] - o[0], py[1] - o[1]]
  const at = (x: number, y: number): Pt => [o[0] + x * ex[0] + y * ey[0], o[1] + x * ex[1] + y * ey[1]]
  return [at(x0, y0), at(x1, y0), at(x0, y1)]
}

/**
 * The Gebäude floor-stack on the ground (decided 14.09.2026: Gebäude IS the floor view).
 *
 * Every storey tile draws the same footprint in the same place, so ONE similarity maps a tile's
 * local coordinates (x = fraction of the board width, y = fraction of the tile's height; the
 * tile is 1/TILE_AR wide for its height) to WGS84 for every floor: tile → footprint-local box (lib/footprint · fpBoxFrac) →
 * isotropic src → ground through `BuildingDoc.geo`. The floor an anno sits on is carried by
 * `anno.floor`, not by the coordinates – which is exactly what lets the stack share the unified
 * object model's PlanFit (lib/tacticalObjects · PlanFit.stack).
 *
 * A building picked before `geo` existed has no ground position and no fit; its ink stays on the
 * Gebäude only, exactly as before.
 */

const srcToGround = (geo: SrcGeoref, [x, y]: Pt) => ({
  lng: geo.origin[0] + (x * geo.spanM) / mPerLon(geo.origin[1]),
  lat: geo.origin[1] - (y * geo.spanM) / M_PER_LAT,
})
const groundToSrc = (geo: SrcGeoref, p: { lng: number; lat: number }): Pt => [
  ((p.lng - geo.origin[0]) * mPerLon(geo.origin[1])) / geo.spanM,
  ((geo.origin[1] - p.lat) * M_PER_LAT) / geo.spanM,
]

/** tile-local → ground for one stack layout (all tiles alike). A PACK stack (`b.pack`) has no
 *  footprint: its tile box IS the page, so the chain is tile → page → ground through the pack's
 *  fit, which the caller passes; a footprint stack goes tile → box → src → ground through `geo`. */
export function stackGroundFit(
  b: Pick<BuildingDoc, 'src' | 'geo' | 'floors' | 'viewDeg' | 'northUp' | 'orientDeg' | 'pack' | 'ringAspect'>,
  packFit?: GeorefFit | null,
): GeorefFit | null {
  const N = b.floors.length || 1
  if (b.pack) {
    if (!packFit) return null
    const { rw, rh } = fpBoxFrac(b.ringAspect, 1, N * TILE_AR, N)
    // the tile box shows the reference drawing's FRAME on its page (whole page when unset)
    const [fx0, fy0, fx1, fy1] = b.pack.frame ?? [0, 0, 1, 1]
    const tileToGround = ([x, y]: Pt) => {
      const u = (x - (0.5 - rw / 2)) / rw, v = (y - (0.5 - rh / 2)) / rh
      return packFit.toMap({ x: fx0 + u * (fx1 - fx0), y: fy0 + v * (fy1 - fy0) })
    }
    const pairs: GeorefPair[] = ([[0.2, 0.3], [0.8, 0.3], [0.5, 0.8]] as Pt[]).map((t) => ({ plan: { x: t[0], y: t[1] }, lngLat: tileToGround(t), kind: 'auto' }))
    return fitSimilarity(pairs, 1 / TILE_AR)
  }
  const src = b.src as Ring[] | undefined
  if (!b.geo || !src?.length) return null
  const view = buildView(src, activeViewDeg(b))
  const { rw, rh } = fpBoxFrac(view.aspect, 1, N * TILE_AR, N)
  const tileToGround = ([x, y]: Pt) => srcToGround(b.geo!, view.fromNorm([(x - (0.5 - rw / 2)) / rw, (y - (0.5 - rh / 2)) / rh]))
  const pairs: GeorefPair[] = ([[0.2, 0.3], [0.8, 0.3], [0.5, 0.8]] as Pt[]).map((t) => ({ plan: { x: t[0], y: t[1] }, lngLat: tileToGround(t), kind: 'auto' }))
  return fitSimilarity(pairs, 1 / TILE_AR) // planAspect is width / height
}

/**
 * Where a floor pack's PDF page lands on a storey tile: the page's corners (0,0), (1,0), (0,1) in
 * footprint-box coordinates (0..1 of the box `fpBoxFrac` draws, the tile's own SVG space), through
 * the pack's shared map fit and back down through the building's geo anchor and CURRENT view angle
 * – so the page turns with the building. Null when either frame is missing.
 */
export function pagePlacement(
  b: Pick<BuildingDoc, 'src' | 'geo'>,
  angleDeg: number,
  pageFit: GeorefFit,
): [Pt, Pt, Pt] | null {
  const src = b.src as Ring[] | undefined
  if (!b.geo || !src?.length) return null
  const view = buildView(src, angleDeg)
  const at = (x: number, y: number): Pt => view.toNorm(groundToSrc(b.geo!, pageFit.toMap({ x, y })))
  return [at(0, 0), at(1, 0), at(0, 1)]
}

/**
 * Turning the Gebäudeview turns the PAPER, so every bearing drawn on it turns with it.
 *
 * `reorientTo` (components/Whiteboard) already re-glues each annotation's POSITION through the
 * footprint's own frame, so a Brandherd keeps the spot on the earth it marks. Its bearing was
 * left behind: a stored `rotation` is «relative to the paper it is stored on» (lib/planProjection
 * · turnedToSheet), and after a 30° turn of the view the same number points 30° elsewhere on the
 * ground. The symbols the Karte lends the stack DO follow — they are projected through the
 * stack's fit, which turns with the building — so the two halves of one tile disagreed: a
 * Fahrzeug placed on the Karte swung with the building, the identical one drawn on the tile did
 * not (15.09.2026).
 *
 * Only glyphs that HAVE a direction, exactly as the projection decides it, and `rotation2` (the
 * Grosslüfter's fan, the Hubretter's boom) with them. A note's `rotation` is paper decoration and
 * never crosses a frame, so it stays put — the projection leaves it alone too.
 *
 * ⚠️ Absence is a value: an unturned Fahrzeug genuinely IS turned by the delta once the paper
 * moves under it, so it acquires a bearing — and one that comes back to north loses it again,
 * the same normalisation `turnedToGround` makes.
 */
export function reorientBearings(anno: BoardAnno, deltaDeg: number): BoardAnno {
  const turn = (deg: number | undefined): number | undefined => {
    const next = turnedBy(deg ?? 0, deltaDeg)
    return next === 0 ? undefined : next
  }
  const rot = directionalGlyph(anno) ? turn(anno.rotation) : anno.rotation
  const rot2 = directionalGlyph2(anno) ? turn(anno.rotation2) : anno.rotation2
  if (rot === anno.rotation && rot2 === anno.rotation2) return anno
  return { ...anno, rotation: rot, rotation2: rot2 }
}
