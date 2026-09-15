import { TILE_AR } from './whiteboard'
import { activeViewDeg, buildView, fpBoxFrac, type Pt, type Ring } from './footprint'
import { M_PER_LAT, mPerLon } from './buildingTransfer'
import { fitSimilarity, type GeorefFit, type GeorefPair } from './georef'
import type { BuildingDoc, SrcGeoref } from '../types'
import type { FloorPackTile } from './floorPackBinding'

/** Place a drawing in the common frame; never independently centre or fit each crop. */
export function packPagePlacement(frame: [number, number, number, number], tile: FloorPackTile): {
  corners: [Pt, Pt, Pt]; clip: [number, number, number, number]
} {
  const [fx0, fy0, fx1, fy1] = frame
  const fw = fx1 - fx0, fh = fy1 - fy0
  const o: Pt = [(tile.shift[0] - fx0) / fw, (tile.shift[1] - fy0) / fh]
  const [cx0, cy0, cx1, cy1] = tile.clip
  return {
    corners: [o, [o[0] + 1 / fw, o[1]], [o[0], o[1] + 1 / fh]],
    clip: [(cx0 + tile.shift[0] - fx0) / fw, (cy0 + tile.shift[1] - fy0) / fh, (cx1 - cx0) / fw, (cy1 - cy0) / fh],
  }
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
