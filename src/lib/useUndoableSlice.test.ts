// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { useUndoableSlice } from './useUndoableSlice'

/** the shape the real caller has: state owned elsewhere (there: the synced workspace slice). */
function setup(readOnly = false) {
  return renderHook(() => {
    const [value, setValue] = useState<Record<string, string>>({})
    return { value, hist: useUndoableSlice(value, setValue, readOnly) }
  })
}

describe('useUndoableSlice', () => {
  it('steps back and forward through whole snapshots', () => {
    const { result } = setup()
    act(() => result.current.hist.set({ a: 'anwesend' }))
    act(() => result.current.hist.set({ a: 'anwesend', b: 'anwesend' }))
    expect(result.current.hist.canUndo).toBe(true)

    act(() => { result.current.hist.undo() })
    expect(result.current.value).toEqual({ a: 'anwesend' })
    act(() => { result.current.hist.redo() })
    expect(result.current.value).toEqual({ a: 'anwesend', b: 'anwesend' })
  })

  // the caller names what changed in the Verlauf from this, instead of keeping a second copy
  it('reports the snapshots it moved between', () => {
    const { result } = setup()
    act(() => result.current.hist.set({ a: 'anwesend' }))
    let moved: { from: unknown; to: unknown } | null = null
    act(() => { moved = result.current.hist.undo() })
    expect(moved).toEqual({ from: { a: 'anwesend' }, to: {} })
  })

  // ⚠️ Two writes in ONE handler are ordinary here (assigning a role fills «Name» and «Stv.» in
  // the same commit). With the render's value as the checkpoint both were identical: the first ↶
  // worked, the second did nothing while still offering itself.
  it('checkpoints each of several writes in the same commit', () => {
    const { result } = setup()
    act(() => {
      result.current.hist.set((cur) => ({ ...cur, a: 'anwesend' }))
      result.current.hist.set((cur) => ({ ...cur, b: 'anwesend' }))
    })
    expect(result.current.value).toEqual({ a: 'anwesend', b: 'anwesend' })

    act(() => { result.current.hist.undo() })
    expect(result.current.value).toEqual({ a: 'anwesend' })
    act(() => { result.current.hist.undo() })
    expect(result.current.value).toEqual({})
    expect(result.current.hist.canUndo).toBe(false)
  })

  it('reports nothing to do at the ends of the stack', () => {
    const { result } = setup()
    expect(result.current.hist.undo()).toBeNull()
    expect(result.current.hist.redo()).toBeNull()
  })

  // a new write is a new branch — the same rule the document history follows
  it('drops the redo branch once something else is written', () => {
    const { result } = setup()
    act(() => result.current.hist.set({ a: 'anwesend' }))
    act(() => { result.current.hist.undo() })
    act(() => result.current.hist.set({ b: 'anwesend' }))
    expect(result.current.hist.canRedo).toBe(false)
  })

  // ⚠️ remote/merged state arrived: the stack describes a list that no longer exists, and
  // stepping into it would write somebody else's rows back over the merge.
  it('clears the stack wholesale', () => {
    const { result } = setup()
    act(() => result.current.hist.set({ a: 'anwesend' }))
    act(() => result.current.hist.clear())
    expect(result.current.hist.canUndo).toBe(false)
    expect(result.current.value).toEqual({ a: 'anwesend' })
  })

  it('writes nothing at all for a viewer', () => {
    const { result } = setup(true)
    act(() => result.current.hist.set({ a: 'anwesend' }))
    expect(result.current.value).toEqual({})
    expect(result.current.hist.canUndo).toBe(false)
  })
})
