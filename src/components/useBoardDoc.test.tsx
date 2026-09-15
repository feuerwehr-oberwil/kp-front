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
      hist: {}, setHist: vi.fn(), log: vi.fn(), selId: null, setSelId: vi.fn(), editId: null, setEditId: vi.fn(),
    }))
    act(() => result.current.patchCommit('s', { label: 'Updated' }))
    expect(calls).toEqual(['checkpoint', 'write', 'end', 'event'])
  })
})
