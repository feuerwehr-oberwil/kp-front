/**
 * «Spur»: the searched area outlives its marker (18.09.2026).
 *
 * What is pinned here is the whole of the rule — a marker that vanishes leaves a ghost, one that
 * comes back takes its trail home again (which is what makes the removal's own ↶ the ONE step),
 * a deliberately deleted ghost is not written straight back, and the ids are derived so two
 * devices reconciling the same removal converge instead of drawing one walked line twice.
 */
import { describe, expect, it } from 'vitest'
import {
  ghostTrailId, ghostTrailLabel, liveGhostTrails, mapGhostTrails, planGhostTrails,
  ghostRevival, reconcileGhostTrails, removeGhostTrail, restoreGhostTrail, trailPointCount, trailSources,
  type TrailSource, type TruppTrail,
} from './truppTrails'
import { mergeWorkspace } from './mergeWorkspace'
import { objectsFromLegacy } from './tacticalObjects'
import type { BoardAnno, BoardDoc, Entity } from '../types'

const AT = '2026-09-18T03:12:00.000Z'

const chip = (p: Partial<BoardAnno> & { id: string }): BoardAnno => ({ kind: 'resource', ...p } as BoardAnno)
const ent = (p: Partial<Entity> & { id: string }): Entity => ({ kind: 'team', layer: 'taktik', coord: [7.57, 47.52], ...p } as Entity)
const objs = (entities: Entity[], board: BoardDoc) => objectsFromLegacy(entities, [], board)
const stack = (id: string) => id === 'gebaeude'
const noOf = (id: string | undefined) => (id === 'tr1' ? 3 : undefined)

describe('what a live marker offers the reconciliation', () => {
  it('reads a plan chip in sheet coordinates and a map marker in geo — by ANCHOR, not by collection', () => {
    const src = trailSources(objs(
      [ent({ id: 'e1', label: 'Meier', trail: [{ coord: [7.5, 47.5], t: '03:10' }] })],
      { gebaeude: [chip({ id: 'a1', text: 'Müller', truppId: 'tr1', floor: 2, trail: [{ x: 0.4, y: 0.5, t: '03:11' }] })] },
    ), stack, noOf)
    const plan = src.find((s) => s.sourceId === 'a1')!
    expect(plan.planId).toBe('gebaeude')
    expect(plan.floorStack).toBe(true)
    expect(plan.truppNo).toBe(3)
    // a legacy point with no storey of its own was walked on the chip's tile
    expect(plan.points).toEqual([{ x: 0.4, y: 0.5, t: '03:11', floor: 2 }])
    expect(plan.geo).toBeUndefined()
    const map = src.find((s) => s.sourceId === 'e1')!
    expect(map.planId).toBeUndefined()
    expect(map.geo).toHaveLength(1)
  })

  it('lists a marker with nothing recorded as EMPTY (it is still standing), and skips a live (GPS) entity', () => {
    const src = trailSources(objs(
      [ent({ id: 'e1', label: 'leer' }), ent({ id: 'v1', label: 'TLF', live: true, trail: [{ coord: [7.5, 47.5], t: '03:10' }] })],
      { gebaeude: [chip({ id: 'a1', text: 'leer', trail: [] })] },
    ), stack, noOf)
    expect(src.map((s) => [s.sourceId, trailPointCount(s)]).sort()).toEqual([['a1', 0], ['e1', 0]])
  })
})

const walked: TrailSource = {
  sourceId: 'a1', truppId: 'tr1', truppNo: 3, name: 'Müller Hans', planId: 'gebaeude', floorStack: true,
  points: [{ x: 0.4, y: 0.5, t: '03:11', floor: 2 }, { x: 0.6, y: 0.5, t: '03:14', floor: 2 }],
}

describe('reconcileGhostTrails', () => {
  it('ghosts a marker that vanished — points, storey and Trupp number intact', () => {
    const out = reconcileGhostTrails([], [walked], [], AT)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(ghostTrailId('a1'))
    expect(out[0].createdAt).toBe(AT)
    expect(out[0].points?.map((p) => p.floor)).toEqual([2, 2])
    expect(ghostTrailLabel(out[0], 'Trupp')).toBe('Trupp 3')
  })

  it('takes the ghost back when the marker returns — which IS the removal’s own undo, one step', () => {
    const ghosted = reconcileGhostTrails([], [walked], [], AT)
    // ↶ on the plan restores the chip WITH its trail; nothing was pushed for the ghost, so the
    // surface's single step is the whole act in both directions
    const back = reconcileGhostTrails(ghosted, [], [walked], AT)
    expect(back).toEqual([])
  })

  it('does nothing — and hands back the SAME array — while the marker just stands there', () => {
    const trails: TruppTrail[] = []
    expect(reconcileGhostTrails(trails, [walked], [walked], AT)).toBe(trails)
  })

  it('does not ghost a marker whose trail was cleared rather than removed', () => {
    // «Spur löschen» on the live marker leaves the marker standing with no points: it is still
    // in the live list (empty), so nothing vanished and the deleted points are not written down
    const cleared: TrailSource = { ...walked, points: [] }
    expect(reconcileGhostTrails([], [walked], [cleared], AT)).toEqual([])
  })

  it('never writes a deleted ghost back — the stamp is what remembers the decision', () => {
    const ghosted = reconcileGhostTrails([], [walked], [], AT)
    const deleted = removeGhostTrail(ghosted, ghostTrailId('a1'), AT)
    expect(reconcileGhostTrails(deleted, [walked], [], AT)).toBe(deleted)
    expect(liveGhostTrails(deleted)).toEqual([])
  })

  // «Marker und Spur löschen» (the trash menu on TwinTeamPill): both go, and no searched area is
  // left standing. The row is still WRITTEN — stamped, exactly as «ghosted, then deleted» leaves
  // it — because a skipped one would simply be ghosted again by the next pass.
  it('writes the ghost of a dropped marker already deleted, and never resurrects it', () => {
    const out = reconcileGhostTrails([], [walked], [], AT, new Set(['a1']))
    expect(out).toHaveLength(1)
    expect(out[0].removedAt).toBe(AT)
    expect(liveGhostTrails(out)).toEqual([])
    expect(planGhostTrails(out, 'gebaeude')).toEqual([])
    // the intent is spent: a later pass reads the stamp and leaves it alone
    expect(reconcileGhostTrails(out, [walked], [], AT)).toBe(out)
  })

  it('drops that stamped row again when the marker’s own ↶ brings it back', () => {
    const out = reconcileGhostTrails([], [walked], [], AT, new Set(['a1']))
    expect(reconcileGhostTrails(out, [], [walked], AT)).toEqual([])
  })

  it('leaves a marker nobody dropped alone — the set names exactly one removal', () => {
    const other: TrailSource = { ...walked, sourceId: 'a2' }
    const out = reconcileGhostTrails([], [walked, other], [], AT, new Set(['a2']))
    expect(out.map((t) => [t.sourceId, !!t.removedAt])).toEqual([['a1', false], ['a2', true]])
  })

  it('derives the id from the marker, so two devices reconciling one removal converge', () => {
    const mine = reconcileGhostTrails([], [walked], [], AT)
    const theirs = reconcileGhostTrails([], [walked], [], '2026-09-18T03:12:04.000Z')
    const merged = mergeWorkspace({ trails: [] }, { trails: mine }, { trails: theirs })
    expect((merged.trails as TruppTrail[]).map((t) => t.id)).toEqual([ghostTrailId('a1')])
  })
})

describe('«Spur löschen» on a ghost', () => {
  const ghosted = reconcileGhostTrails([], [walked], [], AT)
  it('stamps rather than drops, and undo un-stamps', () => {
    const gone = removeGhostTrail(ghosted, ghostTrailId('a1'), AT)
    expect(gone[0].removedAt).toBe(AT)
    expect(planGhostTrails(gone, 'gebaeude')).toEqual([])
    const back = restoreGhostTrail(gone, ghostTrailId('a1'))
    expect(back[0].removedAt).toBeUndefined()
    expect(planGhostTrails(back, 'gebaeude')).toHaveLength(1)
  })

  it('is idempotent both ways (a double tap on «Rückgängig» is not a second act)', () => {
    const gone = removeGhostTrail(ghosted, ghostTrailId('a1'), AT)
    expect(removeGhostTrail(gone, ghostTrailId('a1'), AT)).toBe(gone)
    expect(restoreGhostTrail(ghosted, ghostTrailId('a1'))).toBe(ghosted)
  })
})

describe('which surface draws which ghost', () => {
  it('splits by the frame the trail was recorded in — never projected across', () => {
    const mapGhost = reconcileGhostTrails([], [{ sourceId: 'e1', name: 'Meier', geo: [{ coord: [7.5, 47.5], t: '03:10' }] }], [], AT)
    const all = [...reconcileGhostTrails([], [walked], [], AT), ...mapGhost]
    expect(planGhostTrails(all, 'gebaeude').map((t) => t.sourceId)).toEqual(['a1'])
    expect(planGhostTrails(all, 'modul6')).toEqual([])
    expect(mapGhostTrails(all).map((t) => t.sourceId)).toEqual(['e1'])
  })
  // «Trupp wieder platzieren»: the marker comes back under the id its trail was recorded on, so
  // the reconciliation that made the ghost is also what takes it away again.
  it('puts a marker back where its ghost ends, and the ghost goes home with it', () => {
    const ghosted = reconcileGhostTrails([], [walked], [], AT)
    const back = ghostRevival(ghosted[0])
    expect(back).toMatchObject({ surface: 'plan', markerId: 'a1', planId: walked.planId })
    const head = walked.points![walked.points!.length - 1]
    expect(back?.surface === 'plan' && back.at).toEqual({ x: head.x, y: head.y, floor: head.floor })
    expect(back?.trail).toEqual(ghosted[0].points)
    // the revived chip is a live source under the same id again → no ghost left
    expect(reconcileGhostTrails(ghosted, [], [{ ...walked, points: back!.trail as typeof walked.points }], AT)).toEqual([])
    // a deliberately deleted trail offers nothing to come back to
    expect(ghostRevival(removeGhostTrail(ghosted, ghosted[0].id, AT)[0])).toBeNull()
  })
})

// A ghost keeps a COPY of its Trupp's number, and a merge can renumber the Trupp afterwards
// (lib/truppNumbers, docs/trupp-naming.md §7): the label reads through the Trupp while it exists.
describe('ghostTrailLabel — the number its Trupp carries NOW', () => {
  const g = { truppId: 'tr1', truppNo: 1, name: 'Meier A.' }
  it('reads the live Trupp, not the copy taken when the marker went', () => {
    expect(ghostTrailLabel(g, 'Trupp', [{ id: 'tr1', no: 3 }])).toBe('Trupp 3')
  })
  it('falls back to the copy once the Trupp is gone, and to the name for a loose chip', () => {
    expect(ghostTrailLabel(g, 'Trupp', [])).toBe('Trupp 1')
    expect(ghostTrailLabel({ name: 'Trupp 4' }, 'Trupp', [{ id: 'tr1', no: 3 }])).toBe('Trupp 4')
  })
})
