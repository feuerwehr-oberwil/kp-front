// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { fitSimilarity, type GeorefPair } from './georef'
import { useObjectStore } from './useObjectStore'
import { createUndoTimeline } from './undoTimeline'
import { createPlanStepLink } from './planStepLink'
import { objectsFromLegacy, type PlanFit } from './tacticalObjects'
import type { BoardAnno, Entity } from '../types'

/* ONE gesture on a plan is ONE undo step, whichever stack takes it (review of PR #226,
 * 25.09.2026). Wired the way IncidentWorkspace wires it: the plan step lays its entry when it
 * begins (rememberPlanStep), the store lays its own when the fold reaches an object the sheet does
 * not own, and the link withdraws the plan's half. Real store, real timeline. */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN.lng + 100 / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat } },
]
const FITS = new Map<string, PlanFit>([['modul2', { fit: fitSimilarity(PAIRS, 1)!, aspect: 1 }]])
const DONE = { at: '2026-09-23T18:40:00.000Z' }

/** a Karte symbol inside the sheet's frame, and one anno the sheet owns */
const KARTE: Entity = { id: 'g1', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: [ORIGIN.lng + 0.0003, ORIGIN.lat - 0.0001] }
const OWN: BoardAnno = { id: 's1', kind: 'symbol', x: 0.6, y: 0.2, symbol: 'VKF Rettungen' }

function setup() {
  const timeline = createUndoTimeline()
  const planPast: BoardAnno[][] = []
  const link = createPlanStepLink(() => { planPast.pop() })
  const refs: { undo: () => boolean; redo: () => boolean } = { undo: () => false, redo: () => false }
  const { result: store } = renderHook(() => useObjectStore(objectsFromLegacy([KARTE], [], { modul2: [OWN] }), false, {
    getFits: () => FITS, fitsVersion: 0, defaultLayer: 'taktisch',
    onCheckpoint: () => { timeline.push({ domain: 'karte', label: 'Karte', undo: () => refs.undo(), redo: () => refs.redo() }) },
    onForeignStep: () => link.foreignTaken(),
  }))
  refs.undo = () => store.current.undo()
  refs.redo = () => store.current.redo()
  /** a plan step, the way useBoardDoc · commit + IncidentWorkspace · rememberPlanStep take it */
  const planStep = (edit: (a: BoardAnno) => BoardAnno | null) => act(() => {
    planPast.push(store.current.board.modul2 ?? [])
    const drop = timeline.push({ domain: 'plan', scope: 'modul2', label: 'Plan', undo: () => !!planPast.pop(), redo: () => false })
    link.opened('modul2', drop)
    store.current.beginSheetStep()
    store.current.setBoard((b) => ({ ...b, modul2: (b.modul2 ?? []).map((a) => edit(a) ?? a) }))
    store.current.endSheetStep()
    link.closed()
  })
  return { timeline, planPast, store, planStep }
}

describe('a plan step is one ↶, whichever stack owns what it touched', () => {
  it('marking a Karte-owned symbol on the plan lays ONE step, on the store — and ↶ takes it back', () => {
    const { timeline, planPast, store, planStep } = setup()
    planStep((a) => (a.id === 'g1' ? { ...a, done: DONE } : null))
    expect(store.current.doc.entities.find((e) => e.id === 'g1')?.done).toEqual(DONE)
    expect(timeline.peekUndo()?.domain).toBe('karte')
    expect(planPast).toHaveLength(0) // the plan's snapshot went with its entry
    let outcome: ReturnType<typeof timeline.undo> | undefined
    act(() => { outcome = timeline.undo() })
    expect(outcome?.status).toBe('done')
    expect(store.current.doc.entities.find((e) => e.id === 'g1')?.done).toBeUndefined()
    expect(timeline.canUndo()).toBe(false) // no second, empty ↶ that reports a lost step
  })

  it('an edit of the sheet’s OWN symbol keeps its plan step — nothing is withdrawn', () => {
    const { timeline, planPast, planStep } = setup()
    planStep((a) => (a.id === 's1' ? { ...a, done: DONE } : null))
    expect(timeline.peekUndo()?.domain).toBe('plan')
    expect(planPast).toHaveLength(1)
  })

  it('a store step after the plan step closed never withdraws a plan entry', () => {
    const { timeline, store, planStep } = setup()
    planStep((a) => (a.id === 's1' ? { ...a, count: 2 } : null))
    // a discrete Karte write afterwards — its own step, the plan entry stays under it
    act(() => { store.current.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === 'g1' ? { ...e, count: 3 } : e)) })) })
    expect(timeline.peekUndo()?.domain).toBe('karte')
    act(() => { timeline.undo() })
    expect(timeline.peekUndo()?.domain).toBe('plan')
  })
})
