// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DockInfo } from './DockInfo'

afterEach(cleanup)

// Sweep 28.10.2026 #21: Safari never focuses a tapped button, so the tip's `onBlur` never fired on
// an iPhone and the help stayed up until the ⓘ was tapped again.
describe('DockInfo — the floating tip', () => {
  it('closes on a press anywhere else, without the button ever having had focus', () => {
    render(<><DockInfo text="Tippen zum Setzen" /><div data-testid="map" /></>)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('tooltip').textContent).toBe('Tippen zum Setzen')
    fireEvent.pointerDown(screen.getByTestId('map'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('a press on the ⓘ itself is left to its click, which closes it once', () => {
    render(<DockInfo text="Tippen zum Setzen" />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    fireEvent.pointerDown(btn)
    fireEvent.click(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
