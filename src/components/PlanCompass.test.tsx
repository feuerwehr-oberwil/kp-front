// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanCompass } from './PlanCompass'
import { appConfig } from '../config/appConfig'
import { LONG_PRESS_MS } from '../lib/useLongPress'

afterEach(() => { cleanup(); vi.useRealTimers() })

const W = appConfig.copy.whiteboard

// GESTURES.7 (owner 17.11.2026): in an Einsatz a compass hold is Einpassen on every surface – the
// Lage's compass, and now the Plan's north dial, which fits the whole plan.
describe('the Plan’s north dial', () => {
  it('fits the plan on a still hold, and the release does not open the turn popover', () => {
    vi.useFakeTimers()
    const onFit = vi.fn()
    render(<PlanCompass variant="rail" deg={0} controls={<p>turn</p>} onFit={onFit} />)
    const dial = screen.getByRole('button', { name: W.orientMenuTitle })
    fireEvent.pointerDown(dial, { clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 20) })
    expect(onFit).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(dial)
    fireEvent.click(dial)
    expect(screen.queryByText('turn')).toBeNull()
  })

  it('still opens the turn popover on a tap', () => {
    const onFit = vi.fn()
    render(<PlanCompass variant="rail" deg={0} controls={<p>turn</p>} onFit={onFit} />)
    const dial = screen.getByRole('button', { name: W.orientMenuTitle })
    fireEvent.pointerDown(dial)
    fireEvent.pointerUp(dial)
    fireEvent.click(dial)
    expect(onFit).not.toHaveBeenCalled()
    expect(screen.getByText('turn')).toBeTruthy()
  })

  it('fits on a hold even where it is only a read-out', () => {
    vi.useFakeTimers()
    const onFit = vi.fn()
    render(<PlanCompass variant="float" deg={0} onFit={onFit} />)
    fireEvent.pointerDown(screen.getByRole('img', { name: W.northTitle }))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 20) })
    expect(onFit).toHaveBeenCalledTimes(1)
  })

  // CHROME.1 (17.11.2026): «Drehen» is the ✥ ⟳ bar's turn; the dial's word is «Norden», as a door
  // too – only its name says what a tap does
  it('wears «Norden» as the door to turning the building, and keeps its specific name', () => {
    render(<PlanCompass variant="rail" deg={0} controls={<p>turn</p>} />)
    const dial = screen.getByRole('button', { name: W.orientMenuTitle })
    expect(dial.textContent).toBe(W.northRail)
  })
})
