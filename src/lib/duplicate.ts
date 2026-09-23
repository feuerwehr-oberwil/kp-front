import type { Drawing, Entity, LngLat } from '../types'

/**
 * ⌘D on the Karte (IncidentWorkspace · duplicateSelection): the copy of one symbol / shape / note
 * or one drawing, a small nudge away so it is visibly offset and separately selectable. The id is
 * minted by the caller (`newId`), which also owns the commit, the selection and the Verlauf row.
 */

/** ~6–9 m in WGS84 at Swiss latitudes — east and south, so the copy never hides under the original */
export const DUP_OFFSET = 0.00008

export const duplicateEntity = (src: Entity, id: string): Entity =>
  ({ ...src, id, coord: [src.coord[0] + DUP_OFFSET, src.coord[1] - DUP_OFFSET] })

/** every vertex moves by the same nudge, so the copy is the same shape */
export const duplicateDrawing = (src: Drawing, id: string): Drawing =>
  ({ ...src, id, coords: src.coords.map(([x, y]) => [x + DUP_OFFSET, y - DUP_OFFSET] as LngLat) })
