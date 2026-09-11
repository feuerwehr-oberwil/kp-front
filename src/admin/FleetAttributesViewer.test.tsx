// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup , within} from '@testing-library/react'

// Stub the symbol library so the viewer is deterministic. VKF Fahrzeug (title + Fahrer roster)
// and VKF Luefter mobil (Typ, config-listable) cover the cases; ZZ Ohne Felder is in neither
// preset table (no name, no category match), so it is the symbol that declares NO field.
vi.mock('../lib/useSymbols', () => ({
  useSymbols: () => ({
    ready: true,
    order: ['Fahrzeuge / Mittel', 'ZZ Testkategorie'],
    symbols: [
      { cat: 'Fahrzeuge / Mittel', name: 'VKF Fahrzeug', svg: '<svg></svg>' },
      { cat: 'Fahrzeuge / Mittel', name: 'VKF Luefter mobil', svg: '<svg></svg>' },
      { cat: 'ZZ Testkategorie', name: 'ZZ Ohne Felder', svg: '<svg></svg>' },
    ],
    byName: {
      'VKF Fahrzeug': '<svg></svg>',
      'VKF Luefter mobil': '<svg></svg>',
      'ZZ Ohne Felder': '<svg></svg>',
    },
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

  it('writes a dash — not a sentence — in the Felder cell of a symbol without fields', () => {
    render(<FleetAttributesViewer lists={[]} />)
    // Scoped to the row: this table writes «–» in every empty cell (the whole point — one
    // glyph for «nichts hier», never a sentence), so a bare getByText finds several.
    const row = screen.getAllByText('ZZ Ohne Felder')[0].closest('tr')
    expect(row).toBeTruthy()
    expect(within(row as HTMLElement).getAllByText('–').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Keine Felder/)).toBeNull()
  })

  it('shows behaviour (controls) and roster fields read-only', () => {
    render(<FleetAttributesViewer lists={[]} />)
    expect(screen.getAllByText('Eigenschaften').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Drehbar').length).toBeGreaterThan(0)        // rotation control
    expect(screen.getAllByText('Aus Personal').length).toBeGreaterThan(0) // Fahrer roster field
  })
})
