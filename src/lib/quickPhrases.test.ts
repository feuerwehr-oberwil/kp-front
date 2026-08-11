import { describe, expect, it } from 'vitest'
import { acceptPhrase, currentFragment, fuzzyScore, suggestPhrases } from './quickPhrases'

const PHRASES = [
  'Brand unter Kontrolle',
  'Verstärkung angefordert',
  'Wasserversorgung erstellt',
  'Feuer aus',
  'Keine Personen im Gebäude',
]

describe('fuzzyScore', () => {
  it('prefix beats subsequence, subsequence beats no match', () => {
    const prefix = fuzzyScore('verst', 'Verstärkung angefordert')
    const subseq = fuzzyScore('wsv', 'Wasserversorgung erstellt')
    expect(prefix).toBeGreaterThan(subseq)
    expect(subseq).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'Feuer aus')).toBe(0)
  })

  it('is umlaut-tolerant (typing "verstark" still matches Verstärkung)', () => {
    expect(fuzzyScore('verstark', 'Verstärkung angefordert')).toBeGreaterThan(0)
  })
})

describe('currentFragment', () => {
  it('takes everything after the last sentence boundary', () => {
    expect(currentFragment('Erkundung abgeschlossen. verst')).toBe('verst')
    expect(currentFragment('Zeile eins\nbrand un')).toBe('brand un')
    expect(currentFragment('verst')).toBe('verst')
  })
})

describe('suggestPhrases', () => {
  it('suggests nothing until the fragment is meaningful', () => {
    expect(suggestPhrases('', PHRASES)).toEqual([])
    expect(suggestPhrases('v', PHRASES)).toEqual([])
  })

  it('surfaces the best fuzzy matches for the fragment, best first', () => {
    const s = suggestPhrases('AGT eingesetzt. verst', PHRASES)
    expect(s[0].phrase).toBe('Verstärkung angefordert')
  })

  it('a phrase already typed out stops suggesting itself', () => {
    expect(suggestPhrases('Feuer aus', PHRASES).map((m) => m.phrase)).not.toContain('Feuer aus')
  })

  it('caps the list at three', () => {
    expect(suggestPhrases('er', PHRASES).length).toBeLessThanOrEqual(3)
  })

  // ⚠️ Not only at the START of a sentence. Matching the whole fragment meant the suggestions
  // stopped as soon as the entry was more than one phrase long — which is exactly when a long
  // line typed with one thumb is worth completing.
  it('still suggests once the sentence has run on for a few words', () => {
    const s = suggestPhrases('Rauch aus Fenster 2. OG, brand un', PHRASES)
    expect(s[0].phrase).toBe('Brand unter Kontrolle')
    expect(s[0].frag).toBe('brand un')
  })

  it('prefers the longest stretch that completes to something', () => {
    const s = suggestPhrases('Meldung: wasserversorgung erst', PHRASES)
    expect(s[0].phrase).toBe('Wasserversorgung erstellt')
    expect(s[0].frag).toBe('wasserversorgung erst')
  })
})

describe('acceptPhrase', () => {
  it('replaces the typed fragment, keeping earlier sentences', () => {
    expect(acceptPhrase('AGT eingesetzt. verst', 'Verstärkung angefordert', 'verst'))
      .toBe('AGT eingesetzt. Verstärkung angefordert')
    expect(acceptPhrase('bran', 'Brand unter Kontrolle', 'bran')).toBe('Brand unter Kontrolle')
  })

  it('replaces only the matched tail, not the sentence in front of it', () => {
    const text = 'Rauch aus Fenster 2. OG, brand un'
    const [top] = suggestPhrases(text, PHRASES)
    expect(acceptPhrase(text, top.phrase, top.frag))
      .toBe('Rauch aus Fenster 2. OG, Brand unter Kontrolle')
  })

  it('appends rather than mangling the entry when the fragment is gone', () => {
    expect(acceptPhrase('etwas anderes', 'Feuer aus', 'weg')).toBe('etwas anderesFeuer aus')
  })
})
