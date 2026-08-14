// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

// Mock the replay data layer so the component never hits the network. loadReplay drives
// what renders below the banner; the banner + "Zurück zu Live" exit render regardless.
const { loadReplay, stateAt, vehiclesAt } = vi.hoisted(() => ({
  loadReplay: vi.fn(),
  stateAt: vi.fn(async () => null),
  vehiclesAt: vi.fn(() => []),
}))
// Only the IO-shaped exports are stubbed. The gap/step helpers are pure, so the real ones are
// kept via importOriginal — stubbing them would let the component drift away from the logic
// that actually ships, which is the whole thing this test is meant to catch.
vi.mock('../lib/replay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/replay')>()),
  loadReplay,
  stateAt,
  vehiclesAt,
}))

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

  // ⚠️ The Verlauf is handed in, not reconstructed. It used to be read from the past blob,
  // which returns only the frozen legacy echo since the journal moved to its own store — empty
  // on every incident created since, so the lane and the caption silently never appeared.
  const rows = [
    { id: 'r1', at: new Date(1_010_000).toISOString(), text: 'Erkundung Nordseite läuft', icon: 'type', kind: 'journal' },
    { id: 'r2', at: new Date(1_040_000).toISOString(), text: 'Feuer aus', icon: 'type', kind: 'journal' },
  ] as React.ComponentProps<typeof ReplayBar>['journal']

  it('runs the Verlauf line under the bar and moves it with the playhead', async () => {
    setup({ journal: rows })
    // the playhead parks at the incident start — before the first row nothing was written yet,
    // but the line is THERE from the first frame: it must not appear out of nowhere later and
    // shove the controls up on a bottom-anchored bar
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Zeitpunkt' })).toBeTruthy())
    expect(screen.getByText('Kein Eintrag zu diesem Zeitpunkt')).toBeTruthy()
    expect(screen.queryByText('Erkundung Nordseite läuft')).toBeNull()

    // …stepping to the next thing that happened lands on the first row, and the caption says it
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Ereignis' }))
    await waitFor(() => expect(screen.getByText('Erkundung Nordseite läuft')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Ereignis' }))
    await waitFor(() => expect(screen.getByText('Feuer aus')).toBeTruthy())
  })

  it('opens the Verlauf on the row the caption is showing', async () => {
    const onShowEntry = vi.fn()
    setup({ journal: rows, onShowEntry })
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Zeitpunkt' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Ereignis' }))
    await waitFor(() => expect(screen.getByText('im Verlauf')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'im Verlauf' }))
    expect(onShowEntry).toHaveBeenCalledWith('r1')
  })

  it('⚠️ reports the playhead only when it crosses a row, not per frame', async () => {
    const onPlayhead = vi.fn()
    setup({ journal: rows, onPlayhead })
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Zeitpunkt' })).toBeTruthy())
    const before = onPlayhead.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Ereignis' }))
    await waitFor(() => expect(onPlayhead.mock.calls.length).toBe(before + 1))
    // the same row again is not a crossing — App must not re-render for it
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriges Ereignis' }))
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Ereignis' }))
    await waitFor(() => expect(screen.getByText('Erkundung Nordseite läuft')).toBeTruthy())
    expect(onPlayhead.mock.calls.length).toBeLessThanOrEqual(before + 3)
  })

  it('shows the error state when the bundle fails to load', async () => {
    loadReplay.mockReset().mockRejectedValue(new Error('boom'))
    setup()
    await waitFor(() => expect(screen.getByText('Verlauf konnte nicht geladen werden.')).toBeTruthy())
    // the banner + exit still render in the error state
    expect(screen.getByRole('button', { name: /Zurück zu Live/ })).toBeTruthy()
  })
})
