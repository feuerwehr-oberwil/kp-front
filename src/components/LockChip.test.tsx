// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LockChip } from './LockChip'
import { NODE_HOLD_FIRE_MS } from '../lib/nodeHold'

afterEach(() => { cleanup(); vi.useRealTimers() })

// CTL.8 (13.11.2026): a tap on the 🔒 used to do nothing at all. It now opens the drawing's
// editor, where «Sperren» unlocks; the hold stays the fast way and its release is not a tap.
describe('LockChip', () => {
  it('a tap opens the editor and unlocks nothing', () => {
    const onUnlock = vi.fn(), onOpen = vi.fn()
    render(<LockChip onUnlock={onUnlock} onOpen={onOpen} />)
    const chip = screen.getByRole('button')
    fireEvent.pointerDown(chip, { clientX: 5, clientY: 5 })
    fireEvent.pointerUp(window)
    fireEvent.click(chip)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('a finished hold unlocks, and its trailing click opens nothing on top', () => {
    vi.useFakeTimers()
    const onUnlock = vi.fn(), onOpen = vi.fn()
    render(<LockChip onUnlock={onUnlock} onOpen={onOpen} />)
    const chip = screen.getByRole('button')
    fireEvent.pointerDown(chip, { clientX: 5, clientY: 5 })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS + 100) })
    fireEvent.pointerUp(window)
    fireEvent.click(chip)
    expect(onUnlock).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
