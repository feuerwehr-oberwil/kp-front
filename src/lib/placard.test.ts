import { describe, expect, it } from 'vitest'
import { anyPlacardUn, placardSvgForSymbol } from './placard'
import { appConfig } from '../config/appConfig'
// The ADR dataset is a fetched static asset now (lib/staticData) — inject it the way a
// surface's load would, so the derived values (Kemler on the plate, ERG rows) are real.
import unData from '../../public/un-hazard.json'
import { __setUnHazardData, type UnHazardEntry } from './unHazard'
__setUnHazardData(unData as UnHazardEntry[])


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

describe('anyPlacardUn — whether a surface draws a plate that needs the ADR table', () => {
  const tafel = appConfig.symbols.placardName
  const un = appConfig.copy.contextPanel.unField
  it('is true for a Tafel with a UN-Nr (either key spelling), false otherwise', () => {
    expect(anyPlacardUn([{ symbol: tafel, fields: { [un]: '1203' } }])).toBe(true)
    expect(anyPlacardUn([{ symbol: tafel, fields: { [un.replace(/\.$/, '')]: '1203' } }])).toBe(true)
    expect(anyPlacardUn([{ symbol: tafel, fields: { [un]: '  ' } }, { symbol: 'VKF Fahrzeug', fields: { [un]: '1203' } }])).toBe(false)
  })
})
