// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { requestSafetyPick, useSafetyPickAnswer } from './safetyPick'

afterEach(() => { cleanup(); vi.useRealTimers() })

// The «Kein Sicherungstrupp bereit» row's pick reaches the board (owner pick UX journeys M·16)
describe('requestSafetyPick', () => {
  it('goes to the answering board at once', () => {
    const board = vi.fn()
    renderHook(() => useSafetyPickAnswer(board))
    requestSafetyPick({ kind: 'new' })
    expect(board).toHaveBeenCalledWith({ kind: 'new' })
  })

  it('waits for the board the row brought forward, and is answered once', () => {
    requestSafetyPick({ kind: 'designate', id: 'w' })
    const first = vi.fn()
    const r = renderHook(() => useSafetyPickAnswer(first))
    expect(first).toHaveBeenCalledWith({ kind: 'designate', id: 'w' })
    r.unmount()
    const second = vi.fn()
    renderHook(() => useSafetyPickAnswer(second))
    expect(second).not.toHaveBeenCalled()
  })

  it('is never taken by a board that may not write, and goes stale after 10 s', () => {
    vi.useFakeTimers()
    requestSafetyPick({ kind: 'new' })
    const viewer = renderHook(() => useSafetyPickAnswer(null))
    viewer.unmount()
    vi.advanceTimersByTime(10_000)
    const board = vi.fn()
    renderHook(() => useSafetyPickAnswer(board))
    expect(board).not.toHaveBeenCalled()
  })
})
