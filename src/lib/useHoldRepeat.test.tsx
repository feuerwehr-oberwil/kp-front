// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useHoldRepeat } from './useHoldRepeat'

function Plus({ onStep }: { onStep: () => void }) {
  return <button {...useHoldRepeat(onStep)}>+</button>
}

const release = () => window.dispatchEvent(new PointerEvent('pointerup'))

describe('useHoldRepeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('a held press repeats the step', () => {
    const onStep = vi.fn()
    render(<Plus onStep={onStep} />)
    fireEvent.pointerDown(screen.getByText('+'))
    act(() => { vi.advanceTimersByTime(1000) })
    release()
    expect(onStep.mock.calls.length).toBeGreaterThan(3)
  })

  // ⚠️ A busy device (a big Einsatz re-rendering after the first step) runs the hold's timer late,
  // and the late timer can come BEFORE the queued pointerup: one tap on «Von Geschoss» counted on
  // (Üben round 4, 24.11.2026). The clock jumps here without running timers – the busy thread –
  // then the due timer runs first, then the release.
  it('a tap is exactly one step, even when the release is dispatched late', () => {
    const onStep = vi.fn()
    render(<Plus onStep={onStep} />)
    fireEvent.pointerDown(screen.getByText('+'))
    vi.setSystemTime(Date.now() + 800)
    act(() => { vi.advanceTimersToNextTimer() })
    release()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onStep).toHaveBeenCalledTimes(1)
  })
})
