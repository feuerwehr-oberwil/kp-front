import { describe, expect, it } from 'vitest'
import { symbolCaptionText, symbolControls, symbolFieldOptions } from './symbols'
import type { SymbolControl } from '../types'

// Sorted set → array for order-independent comparison.
const got = (s: Set<SymbolControl>) => [...s].sort()
const want = (...cs: SymbolControl[]) => [...cs].sort()

describe('symbolControls — gating of which steppers a symbol exposes', () => {
  it('returns the exact preset controls for a known symbol (rotation only)', () => {
    expect(got(symbolControls('VKF Fahrzeug'))).toEqual(want('rotation'))
  })

  it('returns the exact preset controls for a known symbol (floor + spread)', () => {
    expect(got(symbolControls('VKF Feuer'))).toEqual(want('floor', 'spread'))
  })

  it('returns count + floor for a symbol whose preset lists both', () => {
    expect(got(symbolControls('VKF Rettungen'))).toEqual(want('count', 'floor'))
  })

  it('returns rotation + floor for a building wall symbol', () => {
    expect(got(symbolControls('GB BA Wand F30'))).toEqual(want('rotation', 'floor'))
  })

  it('returns floorRange for a stairs/lift symbol', () => {
    expect(got(symbolControls('GB Lift'))).toEqual(want('floorRange'))
  })

  it('an explicit by-name match takes precedence over the category fallback', () => {
    // 'VKF Feuer' is in category 'Schadenlage' (byCat → ['floor']) but its by-name
    // preset (['floor','spread']) must win.
    expect(got(symbolControls('VKF Feuer', 'Schadenlage'))).toEqual(want('floor', 'spread'))
  })

  it('falls back to the category preset when the name is unknown', () => {
    expect(got(symbolControls('No Such Symbol', 'Gebäude'))).toEqual(want('floor'))
  })

  it('a category whose preset lists no controls yields an empty set', () => {
    expect(got(symbolControls('Unknown', 'Wasser'))).toEqual([])
  })

  it('an unknown symbol with no category falls back to ALL THREE built-in steppers', () => {
    expect(got(symbolControls())).toEqual(want('rotation', 'count', 'floor'))
    expect(got(symbolControls('Totally Unknown'))).toEqual(want('rotation', 'count', 'floor'))
  })

  it('an unknown symbol AND unknown category still falls back to all three', () => {
    expect(got(symbolControls('Totally Unknown', 'No Such Category'))).toEqual(
      want('rotation', 'count', 'floor'),
    )
  })
})

describe('symbolFieldOptions — roster fields stay separate from category lists', () => {
  const ROSTER = ['Hans Muster', 'Anna Beispiel']

  it('Offizier exposes a «Funktion» field (config-listed) distinct from the person «Name»', () => {
    const opts = symbolFieldOptions('FW Offizier', 'Führung', ROSTER)
    // Funktion is a config-listable field: present as a key, empty without config (no code default)
    expect(opts.Funktion).toEqual([])
    // …and the person field carries ONLY the roster names — never any function labels
    expect(opts.Name).toEqual(ROSTER)
  })

  it('a person field (Name) is filled with roster names only — no preset/custom merge', () => {
    const opts = symbolFieldOptions('FW Offizier', 'Führung', ROSTER)
    expect(opts.Name).toEqual(ROSTER)
  })

  it('the vehicle Fahrer field (also a roster field) gets roster names only', () => {
    const opts = symbolFieldOptions('VKF Fahrzeug', 'Fahrzeuge / Mittel', ROSTER)
    expect(opts.Fahrer).toEqual(ROSTER)
  })
})

describe('symbolCaptionText — metadata printed under a symbol glyph', () => {
  it('off mode (global or per-symbol) shows nothing', () => {
    expect(symbolCaptionText({ symbol: 'FW Kleinloeschgeraet', fields: { Typ: 'CO2' } }, 'off')).toBeNull()
    expect(symbolCaptionText({ symbol: 'FW Kleinloeschgeraet', fields: { Typ: 'CO2' }, caption: 'off' }, 'auto')).toBeNull()
  })

  it('auto shows the primary field value (value-only, no key)', () => {
    expect(symbolCaptionText({ symbol: 'FW Kleinloeschgeraet', fields: { Typ: 'CO2' } }, 'auto')).toBe('CO2')
  })

  it('auto follows the preset `caption` key, not just the first field', () => {
    // Gefahrentafel leads with UN-Nr but captions on Stoff (appConfig preset)
    expect(symbolCaptionText({ symbol: 'FW Gefahr Tafel', fields: { 'UN-Nr': '1203', Stoff: 'Benzin' } }, 'auto')).toBe('Benzin')
  })

  it('auto falls back to the first filled field when the primary is empty', () => {
    expect(symbolCaptionText({ symbol: 'FW Gefahr Tafel', fields: { 'UN-Nr': '1203', Stoff: '' } }, 'auto')).toBe('1203')
  })

  it('a per-symbol override opts a single symbol in even when the global default is off', () => {
    expect(symbolCaptionText({ symbol: 'FW Kleinloeschgeraet', fields: { Typ: 'CO2' }, caption: 'auto' }, 'off')).toBe('CO2')
  })

  it('all mode joins every filled field with newlines, in preset field order', () => {
    expect(symbolCaptionText({ symbol: 'FW Gefahr Tafel', fields: { 'UN-Nr': '1203', Stoff: 'Benzin' } }, 'all')).toBe('1203\nBenzin')
  })

  it('auto shows a custom label when the symbol has no filled fields', () => {
    // a user-named vehicle/title differs from the auto-formatted symbol name
    expect(symbolCaptionText({ symbol: 'VKF Einsatzleiter', label: 'Müller', fields: { Name: '' } }, 'auto')).toBe('Müller')
  })

  it('auto does NOT echo the auto-formatted symbol name (the glyph already says it)', () => {
    // 'FW Sammelplatz' → label equals its formatted name → nothing worth printing
    expect(symbolCaptionText({ symbol: 'FW Sammelplatz', label: 'Sammelplatz' }, 'auto')).toBeNull()
  })

  it('returns null when there is no field value and no custom label', () => {
    expect(symbolCaptionText({ symbol: 'SI Ueberflurhydrant' }, 'auto')).toBeNull()
  })
})
