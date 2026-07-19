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
})

describe('acceptPhrase', () => {
  it('replaces the typed fragment, keeping earlier sentences', () => {
    expect(acceptPhrase('AGT eingesetzt. verst', 'Verstärkung angefordert'))
      .toBe('AGT eingesetzt. Verstärkung angefordert')
    expect(acceptPhrase('bran', 'Brand unter Kontrolle')).toBe('Brand unter Kontrolle')
  })
})
