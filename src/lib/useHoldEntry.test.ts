// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoldEntry } from './useHoldEntry'

// The hook's timing state machine (CUE_MS=130, HOLD_MS=350) drives three outcomes from a
// pointer press: quick tap → onTap, hold past HOLD_MS → a CHOICE that acts on release, and a
// tap while recording → onHoldStop. We test the timing edges with fake timers and a synthetic
// pointer event (only the bits the hook touches).
//
// ⚠️ `preventDefault` is one of those bits, and it is load-bearing: without it the browser's
// compatibility click lands on whatever mounted under the finger, which is how tapping the
// phone FAB opened the camera instead of the composer.
const pointer = () =>
  ({ pointerId: 1, preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } }) as unknown as React.PointerEvent<HTMLButtonElement>

function setup(recording = false, withPhoto = false) {
  const onTap = vi.fn()
  const onHoldStart = vi.fn()
  const onHoldStop = vi.fn()
  const onHoldPhoto = vi.fn()
  const hook = renderHook(
    (props: { recording: boolean }) =>
      useHoldEntry({
        recording: props.recording,
        onTap,
        onHoldStart,
        onHoldStop,
        ...(withPhoto ? { onHoldPhoto } : {}),
      }),
    { initialProps: { recording } },
  )
  return { hook, onTap, onHoldStart, onHoldStop, onHoldPhoto }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useHoldEntry timing state machine', () => {
  it('suppresses the compatibility click, so the tap cannot land on what opens next', () => {
    const { hook } = setup(false)
    const e = pointer()
    act(() => hook.result.current.handlers.onPointerDown(e))
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('a quick tap (release before HOLD_MS) fires onTap, not onHoldStart', () => {
    const { hook, onTap, onHoldStart } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(100)) // < HOLD_MS, no latch
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onHoldStart).not.toHaveBeenCalled()
  })

  // ⚠️ THE contract of the hold: passing HOLD_MS offers the choice and does nothing else. It
  // used to start the memo here — so the mic opened and the button went red before the chooser
  // had been answered, and picking «Foto» then had to throw that recording away.
  it('holding past HOLD_MS starts NOTHING — it only offers the choice', () => {
    const { hook, onHoldStart, onHoldPhoto } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360)) // > HOLD_MS

    expect(hook.result.current.latched).toBe(true)
    expect(hook.result.current.hover).toBe('audio') // the default the release would take
    expect(onHoldStart).not.toHaveBeenCalled()
    expect(onHoldPhoto).not.toHaveBeenCalled()
  })

  it('releasing a hold without moving starts the voice memo, and never fires onTap', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onHoldStart).toHaveBeenCalledTimes(1)
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

  // A cancel after the choice is showing still RESOLVES it — the finger left the screen, which
  // is a release by any other name. It must not be re-read as a tap that opens the composer.
  it('pointer cancel after the hold latched resolves to the memo, not to a tap', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerCancel())

    expect(onHoldStart).toHaveBeenCalledTimes(1)
    expect(onTap).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })

  // The whole point of the rewrite: the camera is reachable ONLY by an explicit slide onto the
  // photo target. A hold that never moved can never open it.
  it('a hold that never moved cannot reach the camera', () => {
    const { hook, onHoldPhoto, onHoldStart } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onHoldPhoto).not.toHaveBeenCalled()
    expect(onHoldStart).toHaveBeenCalledTimes(1)
  })
})
