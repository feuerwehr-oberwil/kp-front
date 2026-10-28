import { pointRemapper, type Ring, type StackLayout } from './footprint'
import { reorientBearings } from './stackFit'
import type { BoardAnno, BoardPoint } from '../types'

/** One turn of a Gebäude floor-stack: what turns (`src`, lib/footprint), from which view angle
 *  to which, and the board before and after. `toLayout` differs from `layout` only when the
 *  storey band follows the drawing (a pack, lib/footprint · bandAspect) AND the board actually
 *  changes – which is the commit, never the preview (see `reorientAnnos`). */
export interface OrientTurn {
  src: Ring[]
  fromDeg: number
  toDeg: number
  layout: StackLayout
  toLayout?: StackLayout
}

/**
 * Re-glue every floor-stack annotation of a sheet to the same real-world spot after the Gebäude
 * turns from `fromDeg` to `toDeg`: anchors (x/y – symbols, texts, shapes, chips, circles, the
 * Durchgänge on their walls), vertices (Linien, Wände, Flächen – a vertex keeps its own storey),
 * team trails, and the BEARINGS, which are relative to the sheet that just moved
 * (lib/stackFit · reorientBearings).
 *
 * ONE function for both of its callers in components/Whiteboard (28.10.2026, Bastian: «we should
 * have a live view so that everything turns together immediately»):
 *  · the COMMIT (`reorientTo`, on release) – its result is what is written, undone and synced;
 *  · the live PREVIEW while the orientation slider is held – rendered only, never written.
 * The preview passes the board on screen as both layouts, because during the drag the backdrop
 * is drawn into the CURRENT storey band; the commit passes the band the turn lands on. On an
 * outline the two are the same board, so preview at X and commit at X are the same numbers; on a
 * pack they are the same spot of the drawing (reorientAnnos.test).
 *
 * Returns `annos` itself for a turn of nothing; an anno without position or bearing comes back
 * as the same object.
 */
export function reorientAnnos(annos: BoardAnno[], { src, fromDeg, toDeg, layout, toLayout = layout }: OrientTurn): BoardAnno[] {
  if (Math.abs(toDeg - fromDeg) < 0.01 && toLayout === layout) return annos
  const mv = pointRemapper(src, fromDeg, toDeg, layout, toLayout)
  return annos.map((a) => {
    const turned = reorientBearings(a, toDeg - fromDeg)
    if (a.x == null && !a.pts && !a.trail) return turned
    const next: BoardAnno = { ...turned }
    if (a.x != null && a.y != null) [next.x, next.y] = mv([a.x, a.y])
    if (a.pts) next.pts = a.pts.map((p): BoardPoint => { const [x, y] = mv([p[0], p[1]]); return p[2] == null ? [x, y] : [x, y, p[2]] })
    if (a.trail) next.trail = a.trail.map((tp) => { const [x, y] = mv([tp.x, tp.y]); return { ...tp, x, y } })
    return next
  })
}
