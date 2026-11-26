// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUndoableDoc } from './useUndoableDoc'

type Doc = { n: number }
const INIT: Doc = { n: 0 }

describe('useUndoableDoc', () => {
  it('commit advances the doc and undo/redo walk the history', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))

    act(() => result.current.commit((d) => ({ n: d.n + 1 })))
    act(() => result.current.commit((d) => ({ n: d.n + 1 })))
    expect(result.current.doc).toEqual({ n: 2 })
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)

    act(() => { result.current.undo() })
    expect(result.current.doc).toEqual({ n: 1 })
    expect(result.current.canRedo).toBe(true)

    act(() => { result.current.redo() })
    expect(result.current.doc).toEqual({ n: 2 })
  })

  // Regression (07.09.): «Übernehmen» ran createCircle + patchEntity in one tick; commit read
  // the per-render doc snapshot, so the second commit built on the pre-tick doc and silently
  // reverted the first — the Absperrkreis never appeared.
  it('two commits in the same tick compose — the second builds on the first', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    act(() => {
      result.current.commit((d) => ({ n: d.n + 1 }))
      result.current.commit((d) => ({ n: d.n + 10 }))
    })
    expect(result.current.doc).toEqual({ n: 11 })
    act(() => { result.current.undo() })
    expect(result.current.doc).toEqual({ n: 1 }) // two commits stay two undo steps
    act(() => { result.current.undo() })
    expect(result.current.doc).toEqual({ n: 0 })
  })

  it('undo/redo return whether they acted (so the caller can log only real steps)', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    let acted = true
    act(() => { acted = result.current.undo() }) // nothing to undo
    expect(acted).toBe(false)

    act(() => result.current.commit(() => ({ n: 5 })))
    act(() => { acted = result.current.undo() })
    expect(acted).toBe(true)
  })

  it('readOnly neuters commit and undo/redo (viewer / replay)', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, true))
    act(() => result.current.commit(() => ({ n: 99 })))
    expect(result.current.doc).toEqual({ n: 0 }) // unchanged
    expect(result.current.canUndo).toBe(false)
  })

  // RBAC audit (22.10.2026): the raw door and the gesture fold bypassed that gate
  it('readOnly neuters the raw write and the gesture fold too', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, true))
    act(() => {
      result.current.beginDrag()
      result.current.setDocRaw({ n: 1 })
      result.current.endDrag()
    })
    expect(result.current.doc).toEqual({ n: 0 })
    expect(result.current.canUndo).toBe(false)
  })

  it('a drag gesture (beginDrag → silent setDocRaw → endDrag) folds into ONE undo step', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    act(() => {
      result.current.beginDrag()
      result.current.setDocRaw({ n: 1 }) // silent mid-gesture
      result.current.setDocRaw({ n: 2 })
      result.current.endDrag()
    })
    expect(result.current.doc).toEqual({ n: 2 })
    act(() => { result.current.undo() })
    expect(result.current.doc).toEqual({ n: 0 }) // one step back to the pre-gesture snapshot
  })

  it('replace swaps the doc and drops history', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    act(() => result.current.commit(() => ({ n: 1 })))
    expect(result.current.canUndo).toBe(true)
    act(() => result.current.replace({ n: 42 }))
    expect(result.current.doc).toEqual({ n: 42 })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })
})

// sweep 26.11.2026 (PR #810): a Notiz's typing holds a gesture open for as long as it has the
// caret, so another gesture can begin on top of it – and a ↶ can run under it
describe('a gesture ended by its token', () => {
  it('dropping a typing leaves the drag begun after it: the move stays one ↶ step', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    let typing = 0
    act(() => { typing = result.current.beginDrag(); result.current.setDocRaw({ n: 1 }) })
    act(() => { result.current.beginDrag(); result.current.setDocRaw({ n: 2 }) })
    act(() => result.current.dropDrag(typing)) // the Notiz went (another device removed it)
    act(() => { expect(result.current.endDrag()).toBe(true) })
    act(() => { result.current.undo() })
    expect(result.current.current()).toEqual({ n: 1 })
  })

  it('lays no step when a ↶ ran while it was open – ↷ stays', () => {
    const { result } = renderHook(() => useUndoableDoc<Doc>(INIT, false))
    act(() => result.current.commit(() => ({ n: 1 })))
    let typing = 0
    act(() => { typing = result.current.beginDrag(); result.current.setDocRaw({ n: 2 }) })
    act(() => { result.current.undo() })
    act(() => { expect(result.current.endDrag(typing)).toBe(false) })
    expect(result.current.current()).toEqual({ n: 0 })
    act(() => { result.current.redo() })
    expect(result.current.current()).toEqual({ n: 2 })
  })
})
