// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { keepPlanSteps, useBoardDoc, type BoardHistory } from './useBoardDoc'
import type { BoardAnno } from '../types'

describe('discrete plan edit completion', () => {
  it('closes a keyboard property edit after its write, without waiting for pointerup', () => {
    const calls: string[] = []
    const { result } = renderHook(() => useBoardDoc({
      annos: [{ id: 's', kind: 'symbol', x: .5, y: .5 }], activeId: 'modul2',
      onChange: () => calls.push('write'), onCheckpoint: () => calls.push('checkpoint'),
      onStepEnd: () => calls.push('end'), emit: () => calls.push('event'),
      hist: {}, setHist: vi.fn(), selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
    }))
    act(() => result.current.patchCommit('s', { label: 'Updated' }))
    expect(calls).toEqual(['checkpoint', 'write', 'end', 'event'])
  })
})

describe('the board’s own ↶ ↷ are restores, not placements (post-mortem D3, 24.09.2026)', () => {
  it('hands the snapshot back with `gesture: false`, both ways', () => {
    const a = { id: 's', kind: 'symbol' as const, x: .5, y: .5 }
    const onChange = vi.fn()
    const hist = { modul2: { past: [{ id: 'p1', snap: [{ ...a, x: .2 }] }], future: [{ id: 'p2', snap: [{ ...a, x: .8 }] }] } }
    const { result } = renderHook(() => useBoardDoc({
      annos: [a], activeId: 'modul2', onChange, emit: vi.fn(),
      hist, setHist: vi.fn(), selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
    }))
    act(() => result.current.undo())
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, x: .2 }], { gesture: false })
    act(() => result.current.redo())
    expect(onChange).toHaveBeenLastCalledWith([{ ...a, x: .8 }], { gesture: false })
  })
})

describe('a remote merge mid-gesture (25.09.2026)', () => {
  const a = { id: 's', kind: 'symbol' as const, x: .5, y: .5 }
  /** the board as the Whiteboard drives it: annos + the caller-owned stacks, in state */
  const mount = () => {
    const laid: string[] = []
    const hook = renderHook(() => {
      const [annos, setAnnos] = useState<BoardAnno[]>([a])
      const [hist, setHist] = useState<BoardHistory>({})
      const doc = useBoardDoc({
        annos, onChange: setAnnos, emit: vi.fn(), activeId: 'modul2', onCheckpoint: (_p, step) => laid.push(step),
        hist, setHist, selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
      })
      return { doc, hist, setHist }
    })
    return { ...hook, laid }
  }

  it('a gesture whose step the merge took lays a fresh one at its next sample — and only then', () => {
    const { result, laid } = mount()
    act(() => result.current.doc.pushPast()) // first movement
    act(() => result.current.doc.set([{ ...a, x: .6 }]))
    act(() => result.current.doc.set([{ ...a, x: .7 }]))
    expect(laid).toHaveLength(1)
    // the merge drops this plan's steps (keepPlanSteps with nothing kept)
    act(() => result.current.setHist((h) => keepPlanSteps(h, () => false)))
    act(() => result.current.doc.set([{ ...a, x: .8 }]))
    expect(laid).toHaveLength(2)
    expect(result.current.hist.modul2.past.map((s) => s.snap[0].x)).toEqual([.7]) // the merged sheet
    act(() => result.current.doc.set([{ ...a, x: .9 }]))
    expect(laid).toHaveLength(2) // the rest folds into it
  })

  it('keepPlanSteps cuts by step id, and hands the same object back when nothing goes', () => {
    const hist: BoardHistory = { modul2: { past: [{ id: 'x', snap: [] }, { id: 'y', snap: [] }], future: [{ id: 'z', snap: [] }] } }
    expect(keepPlanSteps(hist, () => true)).toBe(hist)
    expect(keepPlanSteps(hist, (id) => id !== 'y').modul2).toEqual({ past: [{ id: 'x', snap: [] }], future: [{ id: 'z', snap: [] }] })
  })

  it('a ↶ asked for another step than the top does nothing', () => {
    const onChange = vi.fn()
    const hist = { modul2: { past: [{ id: 'p1', snap: [{ ...a, x: .2 }] }], future: [] } }
    const { result } = renderHook(() => useBoardDoc({
      annos: [a], activeId: 'modul2', onChange, emit: vi.fn(),
      hist, setHist: vi.fn(), selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
    }))
    let ok = true
    act(() => { ok = result.current.undo('other') })
    expect(ok).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })
})
