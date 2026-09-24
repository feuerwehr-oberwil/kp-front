// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useBoardDoc } from './useBoardDoc'

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
    const hist = { modul2: { past: [[{ ...a, x: .2 }]], future: [[{ ...a, x: .8 }]] } }
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
