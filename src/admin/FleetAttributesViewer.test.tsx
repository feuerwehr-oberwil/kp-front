// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// Stub the symbol library so the viewer is deterministic. VKF Fahrzeug (title + Fahrer roster)
// and VKF Luefter mobil (Typ, config-listable) cover the cases.
vi.mock('../lib/useSymbols', () => ({
  useSymbols: () => ({
    ready: true,
    order: ['Fahrzeuge / Mittel'],
    symbols: [
      { cat: 'Fahrzeuge / Mittel', name: 'VKF Fahrzeug', svg: '<svg></svg>' },
      { cat: 'Fahrzeuge / Mittel', name: 'VKF Luefter mobil', svg: '<svg></svg>' },
    ],
    byName: { 'VKF Fahrzeug': '<svg></svg>', 'VKF Luefter mobil': '<svg></svg>' },
  }),
}))

import { FleetAttributesViewer } from './FleetAttributesViewer'

afterEach(cleanup)

describe('FleetAttributesViewer — read-only config viewer', () => {
  it('renders no editing controls (no inputs except the search filter, no buttons)', () => {
    render(<FleetAttributesViewer lists={[]} />)
    // exactly one text input — the symbol filter — and no action buttons
    const inputs = screen.getAllByRole('textbox')
    expect(inputs).toHaveLength(1)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows an unconfigured field as Freitext (no code-baked default lists)', () => {
    render(<FleetAttributesViewer lists={[]} />)
    expect(screen.getAllByText('Freitext').length).toBeGreaterThan(0)
    expect(screen.getAllByText('frei eingeben').length).toBeGreaterThan(0)
    expect(screen.queryByText('Vorgabe')).toBeNull()           // there is no «Vorgabe» state anymore
  })

  it('shows a configured list as read-only chips badged «Konfiguriert»', () => {
    render(<FleetAttributesViewer lists={[{ symbol: 'VKF Luefter mobil', field: 'Typ', options: ['Sonderlüfter'] }]} />)
    expect(screen.getByText('Sonderlüfter')).toBeTruthy()
    expect(screen.getAllByText('Konfiguriert').length).toBeGreaterThan(0)
  })

  it('shows behaviour (controls) and roster fields read-only', () => {
    render(<FleetAttributesViewer lists={[]} />)
    expect(screen.getAllByText('Eigenschaften').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Drehbar').length).toBeGreaterThan(0)        // rotation control
    expect(screen.getAllByText('Aus Mannschaft').length).toBeGreaterThan(0) // Fahrer roster field
  })
})
