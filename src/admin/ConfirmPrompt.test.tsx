// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmPrompt } from './ui'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ConfirmPrompt — the armed half shared by ConfirmButton and the Links ⋮ menu', () => {
  it('reverts by itself after 8 s, and a parent re-render does not restart the clock', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    const { rerender } = render(<ConfirmPrompt question="Löschen?" onConfirm={vi.fn()} onCancel={onCancel} />)
    act(() => { vi.advanceTimersByTime(5000) })
    rerender(<ConfirmPrompt question="Löschen?" onConfirm={vi.fn()} onCancel={onCancel} />)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('confirms only on the explicit answer', () => {
    const onConfirm = vi.fn()
    render(<ConfirmPrompt question="Löschen?" danger onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
