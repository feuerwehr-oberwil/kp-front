// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoldToDrag, type HoldDragOpts } from './useHoldToDrag'

// Tap selects; a still hold (touch) or a move (mouse) drags; a quick flick stays a pan. Movement/
// release are tracked on window (capture), so the tests dispatch real PointerEvents on window.
// DELAY_MS=180, MOVE_TOL_PX=8 (drag-arm slop), TAP_TOL_PX=16 (release-still-counts-as-tap slop).
const down = (x = 100, y = 100) => ({ clientX: x, clientY: y })

function winEvent(type: string, x: number, y: number) {
  // jsdom has no PointerEvent constructor; the hook only reads clientX/clientY off the event
  const ev = new Event(type)
  ;(ev as unknown as { clientX: number; clientY: number }).clientX = x
  ;(ev as unknown as { clientX: number; clientY: number }).clientY = y
  act(() => void window.dispatchEvent(ev))
}

const cbs = () => ({ onTap: vi.fn(), onHoldStart: vi.fn(), onDragMove: vi.fn(), onDragEnd: vi.fn() })

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('useHoldToDrag', () => {
  const begin = (result: { current: ReturnType<typeof useHoldToDrag> }, c: ReturnType<typeof cbs>, o?: HoldDragOpts) =>
    act(() => result.current.begin(down(), c, o))

  it('touch tap (quick release, no move) selects via onTap', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c)
    act(() => void vi.advanceTimersByTime(80))
    winEvent('pointerup', 100, 100)
    expect(c.onTap).toHaveBeenCalledTimes(1)
    expect(c.onHoldStart).not.toHaveBeenCalled()
  })

  it('touch tap still selects after a fat-finger wobble within the tap slop', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c)
    winEvent('pointermove', 110, 108) // ~12.8px: past drag slop (8) but within tap slop (16)
    act(() => void vi.advanceTimersByTime(200))
    winEvent('pointerup', 110, 108)
    expect(c.onTap).toHaveBeenCalledTimes(1)
    expect(c.onHoldStart).not.toHaveBeenCalled() // moved too much to be a still hold
  })

  it('touch: a big move is a pan — no select, no drag', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c)
    winEvent('pointermove', 100, 130) // 30px > tap slop → pan
    act(() => void vi.advanceTimersByTime(200))
    winEvent('pointerup', 100, 130)
    expect(c.onTap).not.toHaveBeenCalled()
    expect(c.onHoldStart).not.toHaveBeenCalled()
  })

  it('touch: a still hold past the delay arms the drag and streams moves', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c)
    act(() => void vi.advanceTimersByTime(200)) // held still → arm
    expect(c.onHoldStart).toHaveBeenCalledTimes(1)
    winEvent('pointermove', 140, 130)
    expect(c.onDragMove).toHaveBeenCalledWith(140, 130)
    winEvent('pointerup', 140, 130)
    expect(c.onDragEnd).toHaveBeenCalledTimes(1)
    expect(c.onTap).not.toHaveBeenCalled()
  })

  it('mouse: a click (no move) selects via onTap', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c, { mode: 'mouse' })
    winEvent('pointerup', 100, 100)
    expect(c.onTap).toHaveBeenCalledTimes(1)
    expect(c.onHoldStart).not.toHaveBeenCalled()
  })

  it('mouse: a press-and-move drags at once (no hold delay)', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c, { mode: 'mouse' })
    winEvent('pointermove', 120, 100) // 20px move → arm immediately
    expect(c.onHoldStart).toHaveBeenCalledTimes(1)
    expect(c.onDragMove).toHaveBeenCalledWith(120, 100)
    winEvent('pointerup', 120, 100)
    expect(c.onDragEnd).toHaveBeenCalledTimes(1)
    expect(c.onTap).not.toHaveBeenCalled()
  })

  it('canDrag:false — tap still selects but a hold never arms a drag', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c, { canDrag: false })
    act(() => void vi.advanceTimersByTime(300)) // would have armed if drag were allowed
    expect(c.onHoldStart).not.toHaveBeenCalled()
    winEvent('pointerup', 100, 100)
    expect(c.onTap).toHaveBeenCalledTimes(1)
  })

  it('cancel() ends an active drag (restores pan) and aborts a pending press', () => {
    const c = cbs()
    const { result } = renderHook(() => useHoldToDrag())
    begin(result, c)
    act(() => void vi.advanceTimersByTime(200)) // arm
    act(() => result.current.cancel())
    expect(c.onDragEnd).toHaveBeenCalledTimes(1)
    const c2 = cbs()
    begin(result, c2)
    act(() => void vi.advanceTimersByTime(80))
    act(() => result.current.cancel())
    act(() => void vi.advanceTimersByTime(200))
    expect(c2.onHoldStart).not.toHaveBeenCalled()
    expect(c2.onTap).not.toHaveBeenCalled()
  })
})
