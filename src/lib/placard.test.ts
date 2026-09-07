import { describe, expect, it } from 'vitest'
import { placardSvgForSymbol } from './placard'

// The Gefahrentafel's UN field key gained its abbreviation dot ('UN-Nr' → 'UN-Nr.',
// 07.09.2026). Symbols saved before the rename still carry the old key — the plate
// must render for both spellings, or a replayed old incident loses its numbers.
describe('placardSvgForSymbol', () => {
  it('bakes the UN number into the plate under the canonical key', () => {
    const svg = placardSvgForSymbol('FW Gefahr Tafel', { 'UN-Nr.': '1203' })
    expect(svg).toContain('>1203<')
  })

  it('still reads the pre-dot legacy key from old symbols', () => {
    const svg = placardSvgForSymbol('FW Gefahr Tafel', { 'UN-Nr': '1203' })
    expect(svg).toContain('>1203<')
  })

  it('renders nothing without a UN number', () => {
    expect(placardSvgForSymbol('FW Gefahr Tafel', { Stoff: 'Benzin' })).toBeNull()
  })
})
