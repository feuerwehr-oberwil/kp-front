// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoldEntry } from './useHoldEntry'

// The hook's timing state machine (CUE_MS=130, HOLD_MS=350) drives three outcomes from a
// pointer press: quick tap → onTap, hold past HOLD_MS → latched onHoldStart, and a tap while
// recording → onHoldStop. We test the timing edges with fake timers and a synthetic pointer
// event (only the bits the hook touches).
const pointer = () =>
  ({ pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } }) as unknown as React.PointerEvent<HTMLButtonElement>

function setup(recording = false) {
  const onTap = vi.fn()
  const onHoldStart = vi.fn()
  const onHoldStop = vi.fn()
  const hook = renderHook(
    (props: { recording: boolean }) =>
      useHoldEntry({ recording: props.recording, onTap, onHoldStart, onHoldStop }),
    { initialProps: { recording } },
  )
  return { hook, onTap, onHoldStart, onHoldStop }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useHoldEntry timing state machine', () => {
  it('a quick tap (release before HOLD_MS) fires onTap, not onHoldStart', () => {
    const { hook, onTap, onHoldStart } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(100)) // < HOLD_MS, < no latch
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onHoldStart).not.toHaveBeenCalled()
  })

  it('holding past HOLD_MS latches a recording (onHoldStart) and release does NOT fire onTap', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360)) // > HOLD_MS

    expect(onHoldStart).toHaveBeenCalledTimes(1)

    act(() => hook.result.current.handlers.onPointerUp())
    // latched: release keeps recording, so neither onTap nor onHoldStop fire on this release
    expect(onTap).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })

  it('the charging cue (pressing) engages after CUE_MS and clears once latched', () => {
    const { hook } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    expect(hook.result.current.pressing).toBe(false)
    act(() => void vi.advanceTimersByTime(140)) // past CUE_MS, before HOLD_MS
    expect(hook.result.current.pressing).toBe(true)
    act(() => void vi.advanceTimersByTime(220)) // now past HOLD_MS → latched, cue cleared
    expect(hook.result.current.pressing).toBe(false)
  })

  it('a tap while recording fires onHoldStop (stop + save)', () => {
    const { hook, onHoldStop, onTap } = setup(true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(50))
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onHoldStop).toHaveBeenCalledTimes(1)
    expect(onTap).not.toHaveBeenCalled()
  })

  // iPadOS delivers `pointercancel` instead of `pointerup` for a clean tap, so a cancel
  // before HOLD_MS (no latch, not recording) is treated as a tap → onTap fires.
  it('pointer cancel before HOLD_MS is treated as a tap (fires onTap)', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(100))
    act(() => hook.result.current.handlers.onPointerCancel())

    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onHoldStart).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })

  it('pointer cancel AFTER the hold latched keeps recording (fires nothing on cancel)', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360)) // > HOLD_MS → latched (onHoldStart)
    expect(onHoldStart).toHaveBeenCalledTimes(1)

    act(() => hook.result.current.handlers.onPointerCancel())
    // already latched: the cancel must NOT be re-interpreted as a tap
    expect(onTap).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })
})
