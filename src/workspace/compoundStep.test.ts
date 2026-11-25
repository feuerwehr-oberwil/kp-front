// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { compoundSteps } from './compoundStep'
import { createUndoTimeline } from '../lib/undoTimeline'
import { pushBoardPast } from '../components/useBoardDoc'
import { usePlanStacks } from './usePlanStacks'

// One compound act is one timeline group with ONE store step (review of #742, items 1 and 5).

/** a store that lays a step per checkpoint, on the timeline, the way IncidentWorkspace's does */
function fixture() {
  const timeline = createUndoTimeline()
  const steps = compoundSteps(() => timeline.group())
  const laid: { silent: boolean }[] = []
  const checkpoint = () => {
    const { silent } = steps.laid()
    laid.push({ silent })
    timeline.push({ domain: 'karte', label: 'Karte', touches: () => [], undo: () => true, redo: () => true })
  }
  return { timeline, steps, laid, checkpoint }
}

describe('compoundSteps', () => {
  it('inside an act, the first store step is its only one: a plan step and the link lay none', () => {
    const f = fixture()
    const end = f.steps.open()
    expect(f.steps.takeIntoStore(f.checkpoint)).toBe(true) // the hose's plan step: the store takes it
    f.steps.linkCheckpoint(f.checkpoint) // …and the link's picture half needs none of its own
    expect(f.steps.takeIntoStore(f.checkpoint)).toBe(true)
    end()
    expect(f.laid).toEqual([{ silent: false }])
    expect(f.timeline.entries().past).toHaveLength(1)
  })

  it('a link outside any act lays one SILENT store step — its Trupp half writes the counter-row', () => {
    const f = fixture()
    f.steps.linkCheckpoint(f.checkpoint)
    f.checkpoint() // the next ordinary store step speaks again
    expect(f.laid).toEqual([{ silent: true }, { silent: false }])
  })

  it('outside an act a plan step stays the plan\'s', () => {
    const f = fixture()
    expect(f.steps.takeIntoStore(f.checkpoint)).toBe(false)
    expect(f.laid).toEqual([])
  })
})

describe('usePlanStacks · a plan step inside a compound act', () => {
  it('lays no plan entry and withdraws its snapshot', () => {
    const undoHist = createUndoTimeline()
    const takeIntoStore = vi.fn(() => true)
    const ref = <T,>(current: T) => ({ current })
    const { result } = renderHook(() => usePlanStacks({
      undoHist, histStep: (moved) => moved, beginSheetStep: vi.fn(), endSheetStep: vi.fn(), setBoard: vi.fn(),
      boardRef: ref({}), activePlanIdRef: ref('modul6'), planLabelRef: ref(() => 'Modul 6'),
      planStepLabelRef: ref(null), stepLabelRef: ref(null), planStepLinkRef: ref(null), takeIntoStore,
    }))
    // what useBoardDoc · pushPast does first: the snapshot, then the report
    act(() => { result.current.setPlanHistory((m) => pushBoardPast(m, 'modul6', [], 'pl1')) })
    act(() => { result.current.rememberPlanStep('modul6', 'pl1') })
    expect(takeIntoStore).toHaveBeenCalledWith(expect.stringContaining('Modul 6'))
    expect(undoHist.canUndo()).toBe(false)
    expect(result.current.planHistory.modul6?.past ?? []).toEqual([])
  })
})
