import { describe, expect, it } from 'vitest'
import {
  fillTemplate,
  formatSymbolName,
  formatTime,
  initials,
  restoreUmlauts,
  roleLabel,
} from './format'

describe('restoreUmlauts', () => {
  it('restores transliterated umlauts (lower + upper variants)', () => {
    expect(restoreUmlauts('Loeschgeraet')).toBe('Löschgerät')
    expect(restoreUmlauts('loeschen')).toBe('löschen')
    expect(restoreUmlauts('Sanitaet')).toBe('Sanität')
    expect(restoreUmlauts('Ueberflur')).toBe('Überflur')
    expect(restoreUmlauts('ueber')).toBe('über')
  })

  it('restores the whole-word "Ture" → "Türe" only on a word boundary', () => {
    expect(restoreUmlauts('Ture')).toBe('Türe')
    // \bTure\b should not touch a longer word that merely contains the letters
    expect(restoreUmlauts('Turestall')).toBe('Turestall')
  })

  it('leaves genuine (non-transliterated) German words alone', () => {
    expect(restoreUmlauts('Feuer')).toBe('Feuer')
    expect(restoreUmlauts('Wasser')).toBe('Wasser')
  })

  it('returns an empty string unchanged', () => {
    expect(restoreUmlauts('')).toBe('')
  })

  it('replaces every occurrence in a string (global)', () => {
    expect(restoreUmlauts('Ueber und ueber')).toBe('Über und über')
  })
})

describe('initials', () => {
  it('takes first + last initial for a multi-word name', () => {
    expect(initials('Hans Müller')).toBe('HM')
    expect(initials('Anna Maria Schmid')).toBe('AS')
  })

  it('takes the first two letters of a single word', () => {
    expect(initials('Posten')).toBe('PO')
  })

  it('folds umlauts so they map to ASCII initials', () => {
    // "Führungsunterstützung" → "FU", not "FÜ"
    expect(initials('Führungsunterstützung')).toBe('FU')
    expect(initials('Über Ärger')).toBe('UA')
    expect(initials('ßeta')).toBe('SS')
  })

  it('returns "?" for an empty / whitespace-only name', () => {
    expect(initials('')).toBe('?')
    expect(initials('   ')).toBe('?')
  })

  it('collapses repeated whitespace between words', () => {
    expect(initials('Hans   Peter')).toBe('HP')
  })

  it('uppercases the result', () => {
    expect(initials('hans müller')).toBe('HM')
  })
})

describe('roleLabel', () => {
  it('labels editor as "Bearbeiter"', () => {
    expect(roleLabel('editor')).toBe('Bearbeiter')
  })

  it('labels anything else (viewer) as "Betrachter"', () => {
    expect(roleLabel('viewer')).toBe('Betrachter')
    expect(roleLabel('whatever')).toBe('Betrachter')
    expect(roleLabel('')).toBe('Betrachter')
  })
})

describe('formatSymbolName', () => {
  it('uses the curated display-name override when present', () => {
    expect(formatSymbolName('VKF Feuer')).toBe('Feuer')
    expect(formatSymbolName('SI Ueberflurhydrant')).toBe('Überflurhydrant')
  })

  it('trims before looking up the override', () => {
    expect(formatSymbolName('  VKF Feuer  ')).toBe('Feuer')
  })

  it('strips a known name prefix and restores umlauts when no override exists', () => {
    // 'GB Loeschposten' has no override → strip 'GB ' prefix, restore umlaut
    expect(formatSymbolName('GB Loeschposten')).toBe('Löschposten')
  })

  it('strips a leading "<num> <num> " sequence', () => {
    expect(formatSymbolName('FW 12 34 Gefahr')).toBe('Gefahr')
  })

  it('leaves an unprefixed unknown name as-is (after umlaut restore)', () => {
    expect(formatSymbolName('Sanitaet')).toBe('Sanität')
  })
})

describe('formatTime', () => {
  it('formats hours:minutes by default (de-CH, 2-digit)', () => {
    const d = new Date(2026, 5, 20, 9, 5, 7)
    // de-CH uses a colon separator and 24h clock → "09:05"
    expect(formatTime(d)).toBe('09:05')
  })

  it('includes seconds when asked', () => {
    const d = new Date(2026, 5, 20, 9, 5, 7)
    expect(formatTime(d, true)).toBe('09:05:07')
  })

  it('pads single-digit hours', () => {
    const d = new Date(2026, 5, 20, 1, 2, 3)
    expect(formatTime(d)).toBe('01:02')
  })
})

describe('fillTemplate', () => {
  it('substitutes named placeholders', () => {
    expect(fillTemplate('Hallo {name}', { name: 'Welt' })).toBe('Hallo Welt')
  })

  it('stringifies numeric values', () => {
    expect(fillTemplate('{n} Fahrzeuge', { n: 5 })).toBe('5 Fahrzeuge')
  })

  it('replaces a missing key with an empty string', () => {
    expect(fillTemplate('a{missing}b', {})).toBe('ab')
  })

  it('replaces a placeholder whose value is 0 with "0", not empty', () => {
    expect(fillTemplate('{n}', { n: 0 })).toBe('0')
  })

  it('handles repeated placeholders and leaves literal braces-free text intact', () => {
    expect(fillTemplate('{x}-{x}', { x: 'q' })).toBe('q-q')
    expect(fillTemplate('no placeholders', {})).toBe('no placeholders')
  })
})
