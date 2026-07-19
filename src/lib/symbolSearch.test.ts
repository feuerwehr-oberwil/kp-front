import { describe, expect, it } from 'vitest'
import { symbolMatchesQuery } from './symbolSearch'
import type { SymbolMeta } from '../types'

const sym = (name: string, cat: string): SymbolMeta => ({ name, cat, svg: '<svg/>' })

const tafel = sym('FW Gefahr Tafel', 'Gefahren')
const ueberflur = sym('SI Ueberflurhydrant', 'Wasser')
const feuer = sym('VKF Feuer', 'Schadenlage')
const luefter = sym('VKF Luefter mobil', 'Fahrzeuge / Mittel')

describe('symbolMatchesQuery', () => {
  it('matches the raw transliterated key and the umlaut display name', () => {
    expect(symbolMatchesQuery(sym('VKF Sanitaetshilfsstelle', 'Personen / Sanität'), 'sanitaet')).toBe(true)
    expect(symbolMatchesQuery(sym('VKF Sanitaetshilfsstelle', 'Personen / Sanität'), 'sanität')).toBe(true)
  })

  it('matches configured synonyms (Gefahrentafel via UN / ADR / Gefahrgut)', () => {
    expect(symbolMatchesQuery(tafel, 'un')).toBe(true)
    expect(symbolMatchesQuery(tafel, 'ADR')).toBe(true)
    expect(symbolMatchesQuery(tafel, 'gefahrgut')).toBe(true)
    expect(symbolMatchesQuery(tafel, 'kemler')).toBe(true)
  })

  it('matches the category heading, so "wasser" finds the Hydranten', () => {
    expect(symbolMatchesQuery(ueberflur, 'wasser')).toBe(true)
    expect(symbolMatchesQuery(feuer, 'wasser')).toBe(false)
  })

  it('is umlaut-tolerant in both directions for aliases', () => {
    // alias "Belüftung" — found by both the umlaut and the transliterated spelling
    expect(symbolMatchesQuery(luefter, 'belüftung')).toBe(true)
    expect(symbolMatchesQuery(luefter, 'belueftung')).toBe(true)
  })

  it('finds the Absperrung pair via Behelf-Schadenplatz terms, umlaut-tolerant', () => {
    const absperrung = sym('FW Absperrung', 'Führung')
    const sperreUeberwacht = sym('VKF Verkehrssperre ueberwacht', 'Führung')
    expect(symbolMatchesQuery(absperrung, 'absperrung')).toBe(true)
    expect(symbolMatchesQuery(absperrung, 'sperrzone')).toBe(true)
    expect(symbolMatchesQuery(sperreUeberwacht, 'überwachung')).toBe(true)
    expect(symbolMatchesQuery(sperreUeberwacht, 'ueberwachung')).toBe(true)
    expect(symbolMatchesQuery(sperreUeberwacht, 'bewacht')).toBe(true)
  })

  it('matches vehicle jargon like TLF', () => {
    expect(symbolMatchesQuery(sym('VKF Fahrzeug', 'Fahrzeuge / Mittel'), 'tlf')).toBe(true)
  })

  it('never matches an empty query', () => {
    expect(symbolMatchesQuery(feuer, '')).toBe(false)
    expect(symbolMatchesQuery(feuer, '   ')).toBe(false)
  })
})
