import type { BoardAnno } from '../types'

/** A range is one object; its home tile is only the editing anchor. */
export function stackRange(anno: BoardAnno): { from: number; to: number } {
  const from = anno.floorFrom ?? anno.floorTo ?? anno.floor ?? 0
  return { from, to: anno.floorTo ?? from }
}

/** Read a floor drag as a translation of the whole range, and a range edit as new coverage. */
export function normalizeStackEdit(before: BoardAnno, after: BoardAnno): BoardAnno {
  if (after.kind !== 'symbol') return after
  const floor = after.floor ?? 0
  const rangeChanged = before.floorFrom !== after.floorFrom || before.floorTo !== after.floorTo
  const delta = floor - (before.floor ?? 0)
  if (delta && !rangeChanged) {
    const { from, to } = stackRange(before)
    return { ...after, storey: undefined, floorFrom: from + delta, floorTo: to + delta }
  }
  if (rangeChanged) {
    const { from, to } = stackRange(after)
    return { ...after, storey: undefined, floor: floor >= Math.min(from, to) && floor <= Math.max(from, to) ? floor : from }
  }
  return after
}

/** Render every covered tile with the full native symbol, without minting another record. */
export function stackInstances(anno: BoardAnno, floors: readonly number[]): BoardAnno[] {
  if (anno.kind !== 'symbol') return [anno]
  const { from, to } = stackRange(anno)
  return floors.filter((floor) => floor >= Math.min(from, to) && floor <= Math.max(from, to))
    .map((floor) => floor === anno.floor ? anno : { ...anno, floor })
}
