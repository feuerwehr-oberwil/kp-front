// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

// Mock the replay data layer so the component never hits the network. loadReplay drives
// what renders below the banner; the banner + "Zurück zu Live" exit render regardless.
const { loadReplay, deriveMarkers, stateAt, vehiclesAt } = vi.hoisted(() => ({
  loadReplay: vi.fn(),
  deriveMarkers: vi.fn(() => []),
  stateAt: vi.fn(async () => null),
  vehiclesAt: vi.fn(() => []),
}))
vi.mock('../lib/replay', () => ({ loadReplay, deriveMarkers, stateAt, vehiclesAt }))

import { ReplayBar } from './ReplayBar'

const bundle = {
  startMs: 1_000_000,
  endMs: 1_060_000,
  events: [],
  samples: [],
}

afterEach(cleanup)
beforeEach(() => {
  loadReplay.mockReset().mockResolvedValue(bundle)
  deriveMarkers.mockReset().mockReturnValue([])
  stateAt.mockReset().mockResolvedValue(null)
  vehiclesAt.mockReset().mockReturnValue([])
})

function setup(over: Partial<React.ComponentProps<typeof ReplayBar>> = {}) {
  const props: React.ComponentProps<typeof ReplayBar> = {
    incidentId: 'inc-1',
    startedAt: new Date(1_000_000).toISOString(),
    onState: vi.fn(),
    onVehicles: vi.fn(),
    onExit: vi.fn(),
    ...over,
  }
  render(<ReplayBar {...props} />)
  return props
}

describe('ReplayBar', () => {
  it('renders the read-only replay banner', () => {
    setup()
    expect(screen.getByText('VERLAUF · WIEDERGABE')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Verlauf-Wiedergabe' })).toBeTruthy()
  })

  it('renders the "Zurück zu Live" exit and calls onExit when clicked', () => {
    const p = setup()
    const exit = screen.getByRole('button', { name: /Zurück zu Live/ })
    fireEvent.click(exit)
    expect(p.onExit).toHaveBeenCalledTimes(1)
  })

  it('renders the transport controls once the bundle loads', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Wiedergabe' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Abspielen' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Zeitpunkt' })).toBeTruthy()
  })

  it('shows the error state when the bundle fails to load', async () => {
    loadReplay.mockReset().mockRejectedValue(new Error('boom'))
    setup()
    await waitFor(() => expect(screen.getByText('Verlauf konnte nicht geladen werden.')).toBeTruthy())
    // the banner + exit still render in the error state
    expect(screen.getByRole('button', { name: /Zurück zu Live/ })).toBeTruthy()
  })
})
