import { describe, expect, it } from 'vitest'
import { acceptJournalSuggestion, journalSuggestions } from './journalSuggestions'
import type { JournalLink } from './journalLinks'

const vocab: JournalLink[] = [
  { name: 'EL', kind: 'person', word: true },
  { name: 'Polizei', kind: 'partner' },
  { name: 'Meier Anna', kind: 'person' },
]
const opts = { vocab, phrases: ['Brand unter Kontrolle', 'Polizei'], timeline: [] }
const suggest = (text: string, caret = text.length) =>
  journalSuggestions(text, { start: caret, end: caret }, opts)

describe('journalSuggestions', () => {
  it('offers a name only once when it is also a configured phrase', () => {
    expect(suggest('Pol').filter((c) => c.label === 'Polizei')).toHaveLength(1)
    expect(suggest('Pol')[0].kind).toBe('partner')
  })

  it('⚠️ the record keeps the SPOKEN word — the long form rides on the chip only', () => {
    // «Hösi Gruppe bereitstellen» is what was said on the radio, and that is what the Verlauf and
    // the Rapport have to read. The chip says «Hösi · Höhensicherung» so the letters can be
    // recognised at 3am; only the two syllables are ever written. See appConfig.journal.abbreviations.
    const withAbbrev = { ...opts, vocab: [{ name: 'Hösi', kind: 'term' as const, hint: 'Höhensicherung', plain: true }] }
    const hit = journalSuggestions('hös', { start: 3, end: 3 }, withAbbrev)[0]
    expect(hit).toMatchObject({ label: 'Hösi', hint: 'Höhensicherung' })
    expect(acceptJournalSuggestion('hös', hit).text).toBe('Hösi ')
  })

  it('ranks an exact phrase prefix above a loose name match', () => {
    const hits = journalSuggestions('Brand un', { start: 8, end: 8 }, {
      ...opts, vocab: [{ name: 'Unterstützung', kind: 'group' }],
    })
    expect(hits[0].label).toBe('Brand unter Kontrolle')
  })

  it('replaces a word at the cursor including its remainder, preserving the rest', () => {
    const text = 'EL → Polzei meldet Rauch'
    const hit = suggest(text, 8).find((c) => c.label === 'Polizei')!
    expect(acceptJournalSuggestion(text, hit)).toEqual({ text: 'EL → Polizei meldet Rauch', caret: 12 })
  })

  it('completes a multiword phrase before an existing sentence', () => {
    const text = 'Meldung: Brand un. EL informiert'
    const hit = suggest(text, 17).find((c) => c.label === 'Brand unter Kontrolle')!
    expect(acceptJournalSuggestion(text, hit).text).toBe('Meldung: Brand unter Kontrolle. EL informiert')
  })

  it('preserves punctuation without adding a space before it', () => {
    const text = 'Mei, bitte melden'
    const hit = suggest(text, 3).find((c) => c.label === 'Meier Anna')!
    expect(acceptJournalSuggestion(text, hit)).toEqual({ text: 'Meier Anna, bitte melden', caret: 10 })
  })

  it('does not duplicate either half of a name when editing inside it', () => {
    for (const [text, caret] of [['Meier Anna meldet Rauch', 3], ['Meier An meldet Rauch', 8], ['Meir Anna meldet Rauch', 3]] as const) {
      const hit = suggest(text, caret).find((c) => c.label === 'Meier Anna')!
      expect(acceptJournalSuggestion(text, hit).text).toBe('Meier Anna meldet Rauch')
    }
  })

  it('replaces the old whole name when selecting a different person inside it', () => {
    const text = 'Meier Anna meldet Rauch'
    const hit = journalSuggestions(text, { start: 3, end: 3 }, {
      ...opts, vocab: [...vocab, { name: 'Meier Bea', kind: 'person' }],
    }).find((c) => c.label === 'Meier Bea')!
    expect(acceptJournalSuggestion(text, hit).text).toBe('Meier Bea meldet Rauch')
  })

  it('offers no replacement over a selected passage', () => {
    expect(journalSuggestions('Pol', { start: 0, end: 3 }, opts)).toEqual([])
  })

  it('puts observed recipients before fallback starters after an arrow', () => {
    const text = 'EL → '
    const hits = journalSuggestions(text, { start: text.length, end: text.length }, {
      ...opts, timeline: [{ id: 'e1', t: '20:00', icon: 'note', text: 'EL → Polizei: bitte melden' }],
      starters: [{ label: 'EL →', insert: 'EL → ', kind: 'opener' },
        { label: 'Brand unter Kontrolle', insert: 'Brand unter Kontrolle', kind: 'phrase' }],
    })
    expect(hits.map((c) => c.label)).toEqual(['Polizei', 'Brand unter Kontrolle'])
    expect(acceptJournalSuggestion(text, hits[0]).text).toBe('EL → Polizei ')
  })
})
