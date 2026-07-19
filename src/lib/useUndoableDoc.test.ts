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
