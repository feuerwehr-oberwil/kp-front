// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHoldEntry } from './useHoldEntry'

// The hook's timing state machine (CUE_MS=130, HOLD_MS=350) drives three outcomes from a
// pointer press: quick tap → onTap, hold past HOLD_MS → a CHOICE that acts on release ONLY if
// the finger slid onto a target (the button itself is the ✕), and a tap while recording →
// onHoldStop. We test the timing edges with fake timers and a synthetic
// pointer event (only the bits the hook touches).
//
// ⚠️ A plain tap resolves on CLICK, not on pointerup — iOS does not deliver the up reliably,
// and every tap on the phone FAB was resolving as a hold. These tests drive both.
const pointer = () =>
  ({
    pointerId: 1,
    // the host is measured when the hold latches, so the chooser can anchor to it
    currentTarget: {
      setPointerCapture: vi.fn(),
      getBoundingClientRect: () => new DOMRect(0, 0, 96, 42),
      offsetWidth: 96, // the freeze uses the LAYOUT width — the FAB is scaled while pressed
    },
  }) as unknown as React.PointerEvent<HTMLButtonElement>

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
  it('a quick tap (release before HOLD_MS) fires onTap once, on the click', () => {
    const { hook, onTap, onHoldStart } = setup(false)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(100)) // < HOLD_MS, no latch
    act(() => hook.result.current.handlers.onPointerUp())
    expect(onTap).not.toHaveBeenCalled() // …the up alone must not open anything
    act(() => hook.result.current.handlers.onClick())

    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onHoldStart).not.toHaveBeenCalled()
  })

  // ⚠️ THE mobile bug: a hold resolves on release, and the click the browser fires afterwards
  // must not then also open the composer on top of the recording that just started.
  it('the click after a resolved hold is swallowed', () => {
    const { hook, onTap } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerUp())
    act(() => hook.result.current.handlers.onClick())

    expect(onTap).not.toHaveBeenCalled()
  })

  // ⚠️ THE contract of the hold: passing HOLD_MS offers the choice and does nothing else. It
  // used to start the memo here — so the mic opened and the button went red before the chooser
  // had been answered, and picking «Foto» then had to throw that recording away.
  it('holding past HOLD_MS starts NOTHING — it only offers the choice', () => {
    const { hook, onHoldStart, onHoldPhoto } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360)) // > HOLD_MS

    expect(hook.result.current.latched).toBe(true)
    expect(hook.result.current.hover).toBe('cancel') // the finger is still on the button = ✕
    expect(onHoldStart).not.toHaveBeenCalled()
    expect(onHoldPhoto).not.toHaveBeenCalled()
  })

  // ⚠️ The cancel: the button turns into an ✕ while the chooser is up, so a hold you thought
  // better of leaves NOTHING behind — no recording, and no composer either.
  it('releasing a hold without moving cancels: nothing starts, and no tap either', () => {
    const { hook, onTap, onHoldStart, onHoldStop, onHoldPhoto } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerUp())
    act(() => hook.result.current.handlers.onClick()) // the click that follows must not open it

    expect(onHoldStart).not.toHaveBeenCalled()
    expect(onHoldPhoto).not.toHaveBeenCalled()
    expect(onTap).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })

  // …and sliding onto a target is what makes it act. The move is hit-tested with
  // elementFromPoint, so the target is faked here rather than laid out.
  it('sliding onto a target is what commits the gesture', () => {
    const { hook, onHoldStart, onHoldPhoto } = setup(false, true)
    // jsdom has no layout, so it has no elementFromPoint at all — stand one in
    const over = (name: string) => {
      document.elementFromPoint = () =>
        ({ closest: () => ({ getAttribute: () => name }) }) as unknown as Element
    }

    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    over('photo')
    act(() => hook.result.current.handlers.onPointerMove({ clientX: 10, clientY: 10 } as React.PointerEvent<HTMLButtonElement>))
    expect(hook.result.current.hover).toBe('photo')
    // …and sliding BACK onto the button re-arms the cancel rather than sticking on the target
    over('cancel')
    act(() => hook.result.current.handlers.onPointerMove({ clientX: 10, clientY: 90 } as React.PointerEvent<HTMLButtonElement>))
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onHoldPhoto).not.toHaveBeenCalled()
    expect(onHoldStart).not.toHaveBeenCalled()
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

  it('a tap while recording fires onHoldStop exactly once, click included', () => {
    const { hook, onHoldStop, onTap } = setup(true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(50))
    act(() => hook.result.current.handlers.onPointerUp())
    act(() => hook.result.current.handlers.onClick())

    expect(onHoldStop).toHaveBeenCalledTimes(1)
    expect(onTap).not.toHaveBeenCalled()
  })

  // keyboard: Enter/Space on a focused button fire a native click, so onClick covers them.
  // There is deliberately no keydown handler — it used to fire onTap and then the browser's
  // own click fired it a second time.
  it('a bare click (keyboard Enter) opens the composer', () => {
    const { hook, onTap } = setup(false)
    act(() => hook.result.current.handlers.onClick())
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  // iPadOS delivers `pointercancel` instead of `pointerup` for a clean tap, and no click
  // follows one — so the cancel has to settle the tap itself.
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
  it('pointer cancel after the hold latched resolves it, and never falls back to a tap', () => {
    const { hook, onTap, onHoldStart, onHoldStop } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerCancel())

    expect(onTap).not.toHaveBeenCalled()
    expect(onHoldStart).not.toHaveBeenCalled()
    expect(onHoldStop).not.toHaveBeenCalled()
  })

  // The whole point of the rewrite: the camera is reachable ONLY by an explicit slide onto the
  // photo target. A hold that never moved can never open it.
  it('a hold that never moved reaches neither the camera nor the mic', () => {
    const { hook, onHoldPhoto, onHoldStart } = setup(false, true)
    act(() => hook.result.current.handlers.onPointerDown(pointer()))
    act(() => void vi.advanceTimersByTime(360))
    act(() => hook.result.current.handlers.onPointerUp())

    expect(onHoldPhoto).not.toHaveBeenCalled()
    expect(onHoldStart).not.toHaveBeenCalled()
  })
})
