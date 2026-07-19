// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Overlays, toast } from './ui'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('toast with an action (confirm-with-undo)', () => {
  it('renders the action button; tapping it runs the handler and dismisses the toast', () => {
    render(<Overlays />)
    const onClick = vi.fn()
    act(() => toast('Geschoss entfernt', { action: { label: 'Rückgängig', onClick } }))

    expect(screen.getByText('Geschoss entfernt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Geschoss entfernt')).toBeNull()
  })

  it('gives an actioned toast a longer default lifetime than a plain one', () => {
    vi.useFakeTimers()
    render(<Overlays />)
    act(() => {
      toast('plain')
      toast('mit Undo', { action: { label: 'Rückgängig', onClick: vi.fn() } })
    })

    act(() => vi.advanceTimersByTime(3000)) // past the plain 2.8s default
    expect(screen.queryByText('plain')).toBeNull()
    expect(screen.getByText('mit Undo')).toBeTruthy()

    act(() => vi.advanceTimersByTime(3500)) // past the 6s action default
    expect(screen.queryByText('mit Undo')).toBeNull()
  })
})
