import type { BoardAnno } from '../types'
import { resolvePlanAnnos } from './lineAttachments'

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

/**
 * What removing one storey of a hand-made Gebäude stack does to the stack's OWN annos — and
 * only to them (24.09.2026).
 *
 * ⚠️ The stack's view also holds the Karte's objects, projected onto the tile of their storey
 * (planProjection · projectOnto). Those are not the storey's: their ground position and their
 * Von/Bis are the Karte's statement, and they stay exactly as they are — once the storey is gone
 * the projection simply finds no tile for it. The sweep used to run over the whole view, and the
 * write seam reads an absent anno as a deletion, so «Geschoss entfernen» deleted every Karte
 * Fahrzeug that happened to be shown on that storey. The caller writes the result through
 * `withOwnAnnos(view, owned, …)`, which hands every lent anno back untouched.
 *
 * What happens to what the storey DOES own (unchanged from before, but for ranges):
 *   · a point object (symbol, note, Trupp chip, …) homed on it goes;
 *   · a Linie/Fläche loses the vertices standing on it, and goes when fewer are left than its
 *     kind needs (2, a Fläche 3) — an end that lost its vertex, or whose docked object went,
 *     lets go of that attachment (the end left behind at where it was drawn);
 *   · a Trupp chip on another storey loses only the breadcrumbs recorded on this one;
 *   · a symbol's Von/Bis RANGE is one object on every covered storey, so it is never deleted
 *     while another covered storey remains: the range shrinks to the storeys still covered, and
 *     a home on the removed storey moves to the lowest of them. Only a range covering nothing
 *     else goes. (It used to go whenever its HOME was the removed storey, span or no span.)
 *
 * `remaining` is the stack's storeys AFTER the removal. `owned` is every id the stack owned
 * BEFORE — a superset of `after`'s, so the removal's write drops the swept ones and its ↶ puts
 * them back through the same door.
 */
export function removeStorey(view: readonly BoardAnno[], ownIds: ReadonlySet<string>, floor: number, remaining: readonly number[]): {
  before: BoardAnno[]; after: BoardAnno[]; owned: Set<string>
} {
  const before = view.filter((a) => ownIds.has(a.id))
  // resolved against the WHOLE view: an own Leitung may be docked onto a lent object
  const resolvedBefore = new Map(resolvePlanAnnos([...view]).map((a) => [a.id, a]))
  const ranged = (a: BoardAnno) => a.kind === 'symbol' && !a.pts?.length && (a.floorFrom != null || a.floorTo != null)
  /** a range covering the removed storey, reshaped onto what is left of it — or `null`: gone */
  const reranged = (a: BoardAnno): BoardAnno | null => {
    const { from, to } = stackRange(a)
    const lo = Math.min(from, to), hi = Math.max(from, to)
    if ((floor < lo || floor > hi) && (a.floor ?? 0) !== floor) return a
    const covered = remaining.filter((f) => f >= lo && f <= hi)
    if (!covered.length) return null
    const nLo = Math.min(...covered), nHi = Math.max(...covered)
    const home = covered.includes(a.floor ?? 0) ? a.floor : nLo
    return { ...a, floor: home, floorFrom: from <= to ? nLo : nHi, floorTo: from <= to ? nHi : nLo }
  }
  const removedIds = new Set(before.filter((a) => ranged(a) ? reranged(a) === null
    : a.pts?.length ? a.pts.every((p) => (p[2] ?? a.floor ?? 0) === floor)
    : (a.floor ?? 0) === floor).map((a) => a.id))
  const after = before.filter((a) => !removedIds.has(a.id)).map((a) => {
    if (ranged(a)) return reranged(a)!
    const oldPts = a.pts ?? []
    let pts = oldPts.filter((p) => (p[2] ?? a.floor ?? 0) !== floor)
    const droppedStart = oldPts.length > 0 && pts.length > 0 && oldPts[0] !== pts[0]
    const droppedEnd = oldPts.length > 0 && pts.length > 0 && oldPts[oldPts.length - 1] !== pts[pts.length - 1]
    const targetGone = (rel: typeof a.startAttachment) => !!rel && removedIds.has(rel.target.id)
    const resolved = resolvedBefore.get(a.id)?.pts
    if (pts.length && resolved && targetGone(a.startAttachment)) pts = pts.map((p, i) => i === 0 ? [resolved[0][0], resolved[0][1], p[2] ?? a.floor ?? 0] : p)
    if (pts.length && resolved && targetGone(a.endAttachment)) pts = pts.map((p, i) => i === pts.length - 1 ? [resolved[resolved.length - 1][0], resolved[resolved.length - 1][1], p[2] ?? a.floor ?? 0] : p)
    const trail = a.trail?.filter((p) => (p.floor ?? a.floor ?? 0) !== floor)
    const touched = pts.length !== oldPts.length || targetGone(a.startAttachment) || targetGone(a.endAttachment) || trail?.length !== a.trail?.length
    // untouched stays the same record — a no-op sample must not read as an edit
    if (!touched) return a
    return {
      ...a,
      ...(a.pts ? { pts } : {}),
      ...(a.trail ? { trail } : {}),
      ...((droppedStart || targetGone(a.startAttachment)) ? { startAttachment: undefined } : {}),
      ...((droppedEnd || targetGone(a.endAttachment)) ? { endAttachment: undefined } : {}),
    }
  }).filter((a) => !a.pts || a.pts.length >= (a.kind === 'area' ? 3 : 2))
  return { before, after, owned: new Set(before.map((a) => a.id)) }
}

/**
 * …and the ↶ of «Geschoss hinzufügen»: the new storey's OWN annos go with it, every lent one stays
 * as shown. The same ownership rule as `removeStorey`, for the same reason — a Karte object whose
 * badge names the new storey is shown on it the moment it exists, and is not the storey's.
 */
export function withoutOwnOnStorey(view: readonly BoardAnno[], ownIds: ReadonlySet<string>, floor: number): BoardAnno[] {
  return view.filter((a) => !ownIds.has(a.id) || (a.floor ?? 0) !== floor)
}
