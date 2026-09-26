// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { pushSliceStep } from './sliceUndoStep'
import { createUndoTimeline } from './undoTimeline'
import { useUndoableSlice } from './useUndoableSlice'

/**
 * A slice wired the way IncidentWorkspace wires Mittel, Checklisten, Rapport and Zeitplan: each
 * write goes through the slice's history AND puts one delegating entry on the timeline, handing
 * over a REF to the history. The ref is synced after every commit — ↶ is only ever pressed then.
 *
 * ⚠️ Regression (23.09.2026): the entry used to receive `histRef.current`, the slice object of
 * the render that wrote, whose stacks do not yet hold the write's own checkpoint. The first ↶
 * after mount was then «lost», and a later one restored one snapshot too far back.
 */
function useTickSlice() {
  const [ticked, setTicked] = useState(false)
  const hist = useUndoableSlice(ticked, setTicked)
  const histRef = useRef(hist)
  useEffect(() => { histRef.current = hist })
  const [timeline] = useState(() => createUndoTimeline())
  const set = (next: boolean) => {
    const laid = hist.set(next)
    pushSliceStep(timeline, { domain: 'checkliste', label: 'Checkliste', laid, histRef, record: (moved) => !!moved })
  }
  return { ticked, set, timeline }
}

describe('pushSliceStep — ↶ steps the slice as it stands NOW', () => {
  it('open → tick → ↶ takes the tick back (the first ↶ after mount is not «lost»)', () => {
    const { result } = renderHook(useTickSlice)
    act(() => result.current.set(true))
    expect(result.current.ticked).toBe(true)
    let status = ''
    act(() => { status = result.current.timeline.undo().status })
    expect(status).toBe('done')
    expect(result.current.ticked).toBe(false)
    act(() => { status = result.current.timeline.redo().status })
    expect(status).toBe('done')
    expect(result.current.ticked).toBe(true)
  })

  it('tick, untick, re-tick → each ↶ steps back exactly one write', () => {
    const { result } = renderHook(useTickSlice)
    act(() => result.current.set(true))
    act(() => result.current.set(false))
    act(() => result.current.set(true))
    const seen: boolean[] = []
    for (let i = 0; i < 3; i++) {
      act(() => { result.current.timeline.undo() })
      seen.push(result.current.ticked)
    }
    // re-tick taken back → unticked; the untick taken back → ticked; the tick → the start
    expect(seen).toEqual([false, true, false])
    expect(result.current.timeline.canUndo()).toBe(false)
  })

  // 25.09.2026: a write that laid no step (a viewer's, or one folded into the standing step) must
  // put nothing on the timeline — the entry would name the step BELOW, somebody else's
  it('a write that laid no step pushes no entry', () => {
    const { result } = renderHook(() => {
      const [v, setV] = useState(0)
      const hist = useUndoableSlice(v, setV, true) // a viewer: `set` lays nothing
      const [timeline] = useState(() => createUndoTimeline())
      return { hist, timeline }
    })
    act(() => {
      const laid = result.current.hist.set(1)
      const drop = pushSliceStep(result.current.timeline, { domain: 'mittel', label: 'Mittel', laid, histRef: { current: result.current.hist }, record: () => true })
      expect(drop.standing()).toBe(false)
    })
    expect(result.current.timeline.canUndo()).toBe(false)
  })
})
