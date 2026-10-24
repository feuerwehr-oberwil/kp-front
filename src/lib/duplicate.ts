import type { BoardAnno, BoardKind, BoardPoint, Drawing, Entity, LngLat } from '../types'
import { freshTeamLabel } from './placedTrupps'

/**
 * ⌘D on both surfaces (useMapActions · duplicateSelection, Whiteboard · duplicateSelection): the
 * copy of ONE object a small nudge away, so it is visibly offset and separately selectable. These
 * are the copy rules, held once for the Karte's and the Plan's store; the id is minted by the
 * caller (`newId`), which also owns the commit, the selection and the Verlauf row.
 *
 * ⚠️ The copy is a NEW thing on the picture, so it does not inherit «Gelöscht / erledigt»
 * (lib/objectDone): a second Feuer placed by ⌘D is burning until somebody says otherwise. And a
 * loose «Trupp 3» copied is not a second Trupp 3 (docs/trupp-naming.md §7): it takes the next
 * number of the one counter, as a chip dropped from the tool would. `counterNames` is that
 * counter, read only when a loose chip is actually copied.
 */
type CounterNames = () => readonly (string | undefined)[]

/** ~6–9 m in WGS84 at Swiss latitudes — east and south, so the copy never hides under the original */
export const DUP_OFFSET = 0.00008

export const duplicateEntity = (src: Entity, id: string, counterNames: CounterNames): Entity => {
  const { done: _done, ...rest } = src
  const copy: Entity = { ...rest, id, coord: [src.coord[0] + DUP_OFFSET, src.coord[1] - DUP_OFFSET] }
  return copy.kind === 'team' && !copy.truppId ? { ...copy, label: freshTeamLabel(copy.label, counterNames()) } : copy
}

/** every vertex moves by the same nudge, so the copy is the same shape */
export const duplicateDrawing = (src: Drawing, id: string): Drawing =>
  ({ ...src, id, coords: src.coords.map(([x, y]) => [x + DUP_OFFSET, y - DUP_OFFSET] as LngLat) })

/** ~2 % of the plan width — the same visible nudge a detached endpoint gets */
export const DUP_OFFSET_N = 0.02
/** the id prefix each Plan kind is minted with (`newId(DUP_PREFIX[kind])`) */
export const DUP_PREFIX: Record<BoardKind, string> = { draw: 'l', area: 'a', circle: 'c', text: 't', symbol: 's', shape: 'sh', resource: 'r', form: 'fm' }

/** The Plan's copy, in plan-width fractions. ⚠️ It carries no `trail`: a recorded track belongs to
 *  the Trupp that walked it, and a duplicate that inherited it would put a fabricated movement
 *  history into the record — and leave a ghost trail behind that nobody ever walked. */
export const duplicateAnno = (src: BoardAnno, id: string, counterNames: CounterNames): BoardAnno => {
  const { done: _done, ...rest } = src
  return {
    ...rest, id, trail: undefined,
    ...(src.kind === 'resource' && !src.truppId ? { text: freshTeamLabel(src.text, counterNames()) } : {}),
    ...(src.pts ? { pts: src.pts.map(([x, y, floor]): BoardPoint => [x + DUP_OFFSET_N, y + DUP_OFFSET_N, floor ?? src.floor ?? 0]) } : {}),
    ...(src.x != null ? { x: src.x + DUP_OFFSET_N } : {}),
    ...(src.y != null ? { y: src.y + DUP_OFFSET_N } : {}),
  }
}
