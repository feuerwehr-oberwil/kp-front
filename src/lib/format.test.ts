import { describe, expect, it } from 'vitest'
import { dueClock, fillTemplate, formatSymbolName, formatTime, initials, isNextDay, restoreUmlauts, roleLabel, stripUnprintable, telHref } from './format'

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

describe('dueClock (a Wiedervorlage that fell to tomorrow)', () => {
  it('prints the bare clock for a due time today', () => {
    const today = new Date()
    today.setHours(23, 30, 0, 0)
    expect(dueClock(today.toISOString())).toBe(formatTime(today))
  })

  it('says «morgen» once the due time is not today — the banner used to hide that', () => {
    const tomorrow = new Date(Date.now() + 26 * 3_600_000)
    expect(dueClock(tomorrow.toISOString())).toContain('morgen')
    expect(isNextDay(tomorrow.toISOString())).toBe(true)
  })
})

// The rapport is set in Helvetica, which has no glyph for any of these — an emoji that survives
// the input is a black box on the sheet that gets signed, and only there.
describe('stripUnprintable', () => {
  it('drops emoji and closes the gap they leave', () => {
    expect(stripUnprintable('Brand 🔥 im 2. OG')).toBe('Brand im 2. OG')
    expect(stripUnprintable('erledigt ✅')).toBe('erledigt ')
    expect(stripUnprintable('👨‍🚒 Trupp 1')).toBe(' Trupp 1')
  })

  it('leaves everything Helvetica can actually set', () => {
    expect(stripUnprintable('Öl · Hauptstrasse 4 – 2. OG, «Nord»')).toBe('Öl · Hauptstrasse 4 – 2. OG, «Nord»')
    expect(stripUnprintable('Müller/Wyss (TLF 1) 300 bar')).toBe('Müller/Wyss (TLF 1) 300 bar')
  })

  it('is a no-op on plain text, so it can sit on every keystroke', () => {
    const s = 'Wasserversorgung ab Hydrant Schlossgasse sichergestellt.'
    expect(stripUnprintable(s)).toBe(s)
  })

  // ⚠️ …except the two the journal writes ON PURPOSE. They sat inside the arrows block this rule
  // strips, so «EL → Sanität» lost its arrow again with the very next keystroke. Helvetica still
  // cannot set them — the PAPER gets «->», mapped where the payload is built (reportPdfDirect).
  it('keeps the two arrows the Funkprotokoll is written with, and no others', () => {
    expect(stripUnprintable('EL → Sanität: Patient stabil')).toBe('EL → Sanität: Patient stabil')
    expect(stripUnprintable('Polizei ← EL')).toBe('Polizei ← EL')
    expect(stripUnprintable('Trupp 2 ⇒ Keller')).toBe('Trupp 2 Keller')
    expect(stripUnprintable('nach ↑ oben')).toBe('nach oben')
  })
})

describe('telHref (the Kontaktperson dial link)', () => {
  it('dials the number as typed, Swiss formatting stripped', () => {
    expect(telHref('079 123 45 67')).toBe('tel:0791234567')
    expect(telHref('+41 61 401 12 34')).toBe('tel:+41614011234')
    expect(telHref('061/401 12 34')).toBe('tel:0614011234')
  })

  it('offers no link where there is nothing dialable', () => {
    expect(telHref('')).toBeUndefined()
    expect(telHref(undefined)).toBeUndefined()
    expect(telHref('-')).toBeUndefined()
    expect(telHref('kommt noch')).toBeUndefined()
  })
})
