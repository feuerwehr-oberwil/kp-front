// Gefahrentafel andocken (Feldtest Manuel, 07.09.: «Evtl. noch andocken?») — the placard
// dropped beside an object becomes ITS placard: `Entity.dockedTo` records the bond, and from
// then on the host drags its placard along, the way a Gefahrentafel physically hangs on the
// tank it describes.
//
// Deliberately narrower than the magnetic line machinery (lib/lineAttachments): no dwell ring,
// no ports, no resolve-at-render — the bond is decided once, on drop, and the placard keeps its
// own honest coordinate. Karte-only, like the ERG rings: on a Plan the placard sits inside a
// drawn Kroki where «daneben» already says everything, and a normalized surface has no metric
// drop radius to reason about.

import type { Entity, LngLat } from '../types'
import { appConfig } from '../config/appConfig'

/** Drop radius in SCREEN pixels, centre to centre. Wider than the line magnet's 32: a placard
 *  is parked NEXT to a ~40 px glyph, not on top of it, so the honest drop zone is the glyph
 *  plus one placard width. Farther than this on release and an existing bond is let go — the
 *  same gesture in reverse. */
export const DOCK_RADIUS_PX = 56

/** May this entity carry a placard? Symbols and parked vehicles — never a live (GPS-fed)
 *  vehicle, whose position updates bypass the drag funnel the carry lives in, and never
 *  another placard: a placard describes an object, not a second placard. */
export function isDockHost(e: Entity): boolean {
  return (e.kind === 'symbol' || e.kind === 'vehicle') && !e.live && e.symbol !== appConfig.symbols.placardName
}

export function isPlacard(e: Entity | undefined): boolean {
  return e?.kind === 'symbol' && e.symbol === appConfig.symbols.placardName
}

/** The host a just-dropped placard bonds to: the nearest dockable entity within
 *  DOCK_RADIUS_PX of the drop, or null — which also means «release the current bond».
 *  `project` is the map's lngLat→screen conversion, injected so this stays pure. */
export function nearestDockHost(
  coord: LngLat,
  entities: readonly Entity[],
  project: (c: LngLat) => { x: number; y: number },
): Entity | null {
  const at = project(coord)
  let best: Entity | null = null
  let bestD = DOCK_RADIUS_PX
  for (const e of entities) {
    if (!isDockHost(e) || !e.coord) continue
    const p = project(e.coord)
    const d = Math.hypot(p.x - at.x, p.y - at.y)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

/** The host moved: shift every placard docked to it by the same delta, so the pair keeps the
 *  offset the operator chose. Pure — the caller decides which document write it happens in
 *  (mid-drag `setDocRaw` and the final commit both run through this). */
export function carryDocked(entities: readonly Entity[], hostId: string, from: LngLat, to: LngLat): Entity[] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (dx === 0 && dy === 0) return [...entities]
  return entities.map((e) =>
    e.dockedTo === hostId && e.coord ? { ...e, coord: [e.coord[0] + dx, e.coord[1] + dy] as LngLat } : e,
  )
}
