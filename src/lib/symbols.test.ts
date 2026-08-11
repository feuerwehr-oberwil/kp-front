import { describe, expect, it } from 'vitest'
import { symbolCaptionText, symbolControls, symbolFieldOptions, symbolPresetFieldKeys } from './symbols'
import type { SymbolControl } from '../types'
import { appConfig } from '../config/appConfig'

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

  it('every driven vehicle exposes a Fahrer roster picker', () => {
    for (const v of ['VKF Fahrzeug', 'VKF Drehleiter', 'VKF Hubretter', 'Grosslüfter', 'FW Boot']) {
      const opts = symbolFieldOptions(v, 'Fahrzeuge / Mittel', ROSTER)
      expect(opts.Fahrer, `${v} must carry a Fahrer field`).toEqual(ROSTER)
    }
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

  it('all mode includes custom (non-preset) fields after the preset ones, then notes', () => {
    // preset fields first (canonical order), then any custom key the operator added, then notes
    expect(symbolCaptionText({
      symbol: 'FW Gefahr Tafel',
      fields: { 'UN-Nr': '1203', Stoff: 'Benzin', Menge: '200 l' },
      notes: 'ausgelaufen',
    }, 'all')).toBe('1203\nBenzin\n200 l\nausgelaufen')
  })

  it('all mode shows notes even when the symbol has no filled fields', () => {
    expect(symbolCaptionText({ symbol: 'SI Ueberflurhydrant', notes: 'defekt' }, 'all')).toBe('defekt')
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

  it('a vehicle stays silent in auto — its name is drawn inside the glyph', () => {
    expect(symbolCaptionText({
      symbol: appConfig.symbols.vehicleName, label: 'TLF 1', fields: { Fahrer: 'Céline Widmer' },
    }, 'auto')).toBeNull()
  })

  it('all mode gives a vehicle everything EXCEPT its name (Fahrer, custom fields, notes)', () => {
    expect(symbolCaptionText({
      symbol: appConfig.symbols.vehicleName,
      label: 'TLF 1',
      fields: { Fahrer: 'Céline Widmer', Test: 'Test', 'Test 2': 'Test 2' },
      notes: 'Tank halb',
    }, 'all')).toBe('Céline Widmer\nTest\nTest 2\nTank halb')
  })

  it('an off override still silences a vehicle in the all default', () => {
    expect(symbolCaptionText({
      symbol: appConfig.symbols.vehicleName, label: 'TLF 1', fields: { Fahrer: 'Céline Widmer' }, caption: 'off',
    }, 'all')).toBeNull()
  })
})

// The symbol pack's presets are config, and a missing entry is invisible rather than loud — the
// symbol simply offers nothing. These pin the ones that were found missing on 2026-08-11.
describe('presets that were silently absent', () => {
  it('every Schadenlage symbol can name a storey', () => {
    // Beschädigung / Teil- / Totalzerstörung / Überschwemmung had NO preset at all, so they were
    // the only damage symbols with no floor — «Teilzerstörung» with no storey is exactly the
    // statement a Kroki cannot afford to leave vague.
    for (const n of ['FW Beschaedigung', 'FW Teilzerstoerung', 'FW Totalzerstoerung', 'FW Ueberschwemmung',
                     'VKF Feuer', 'VKF Rauch', 'VKF Wasser', 'VKF Unfall']) {
      expect(symbolControls(n).has('floor'), n).toBe(true)
    }
  })

  it('every place people are collected can count them', () => {
    for (const n of ['VKF Patientensammelstelle', 'VKF Sanitaetshilfsstelle', 'FW Verwundetennest',
                     'VKF Totensammelstelle', 'VKF Sammelstelle', 'VKF Rettungen']) {
      expect(symbolControls(n).has('count'), n).toBe(true)
    }
  })

  it('…and the Anzahl says WHAT it counts', () => {
    const byName = appConfig.copy.contextPanel.countBySymbol
    expect(byName['FW Verwundetennest']).toBe('Anzahl Verwundete')
    expect(byName['VKF Totensammelstelle']).toBe('Anzahl Verstorbene')
    // anything not listed keeps the plain word
    expect(byName['VKF Feuer']).toBeUndefined()
  })

  it('kit that is carried inside can name the storey it is on', () => {
    // cellar work and stairwell ventilation are the normal case, and the storey was the one
    // thing these could not say. The VEHICLES deliberately keep none — a Drehleiter is outside.
    for (const n of ['VKF Luefter mobil', 'Grosslüfter', 'FW Entrauchung', 'FW Kleinloeschgeraet',
                     'FW Tauchpumpe', 'FW Wassersauger', 'VKF Innenhydrant', 'SI Wasserloeschposten']) {
      expect(symbolControls(n).has('floor'), n).toBe(true)
    }
    for (const n of ['VKF Drehleiter', 'VKF Hubretter', 'FW Boot', 'VKF Fahrzeug']) {
      expect(symbolControls(n).has('floor'), n).toBe(false)
    }
  })

  it('a water source can state its capacity', () => {
    expect(symbolPresetFieldKeys('WV Loeschweier')).toContain('Kapazität')
    expect(symbolPresetFieldKeys('SI Wasserbezugsort')).toContain('Kapazität')
    // …and the box says which unit, because «Kapazität: 80» is ambiguous
    expect(appConfig.copy.contextPanel.fieldPlaceholders['Kapazität']).toContain('m³')
  })
})
