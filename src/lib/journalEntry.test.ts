import { describe, expect, it } from 'vitest'
import { acceptName, composeJournalText, currentWord, suggestLinks } from './journalEntry'
import type { JournalLink } from './journalLinks'

describe('composeJournalText', () => {
  it('leaves a bare entry exactly as it was written', () => {
    expect(composeJournalText('Kellerbrand bestätigt')).toBe('Kellerbrand bestätigt')
  })

  it('⚠️ prints NO marker for «Info» — a marker on the ordinary case is wallpaper', () => {
    expect(composeJournalText('Kellerbrand bestätigt', { entryType: 'info' })).toBe('Kellerbrand bestätigt')
  })

  it('marks the two that are not ordinary', () => {
    expect(composeJournalText('Trupp 2 sichert Treppenhaus', { entryType: 'auftrag' }))
      .toBe('Auftrag · Trupp 2 sichert Treppenhaus')
    expect(composeJournalText('Strom abstellen', { entryType: 'sofort' }))
      .toBe('Sofortmassnahme · Strom abstellen')
  })

  it('⚠️ carries no «Von» any more — the sentence answers that, and the names in it are linked', () => {
    // a second field asking what the sentence already says is a second field to fill in
    expect(composeJournalText('Meier meldet Kellerbrand', { entryType: 'info' }))
      .toBe('Meier meldet Kellerbrand')
  })

  it('keeps a type-only row readable when there are no words', () => {
    expect(composeJournalText('   ', { entryType: 'sofort' })).toBe('Sofortmassnahme')
  })
})

describe('typing a term', () => {
  const vocab: JournalLink[] = [
    { name: 'Baumann Michael', kind: 'person', id: 'p1', present: false },
    { name: 'Meier Anna', kind: 'person', id: 'p2', present: true },
    { name: 'Ölbinder (Granulat)', kind: 'material' },
    { name: 'TLF', kind: 'vehicle' },
  ]

  it('suggests on the WORD, not on the whole sentence', () => {
    expect(suggestLinks('Meier meldet Baum', vocab).map((l) => l.name)).toEqual(['Baumann Michael'])
  })

  it('reaches Material and Fahrzeuge, not only people', () => {
    expect(suggestLinks('3 Sack Ölbind', vocab).map((l) => l.kind)).toEqual(['material'])
  })

  it('offers from two letters on, but only where they START a word', () => {
    expect(suggestLinks('Ba', vocab).map((l) => l.name)).toEqual(['Baumann Michael'])
    // …a word inside the name counts too — «Mi» is how you reach for the Vorname
    expect(suggestLinks('Mi', vocab).map((l) => l.name)).toEqual(['Baumann Michael'])
  })

  it('⚠️ two letters of fuzzy subsequence would put half the Mannschaft under every «im»', () => {
    // 'i','m' are both in «Baumann Michael» in order — a prefix rule is what keeps it quiet
    expect(suggestLinks('Kellerbrand im', vocab)).toEqual([])
    expect(suggestLinks('L', vocab)).toEqual([])
  })

  it('⚠️ …and neither does a LONGER fuzzy subsequence — «sani» is nobody', () => {
    // reported 14.08.: «sani» offered Schneider Melanie (…mel-a-n-i-e) and Wyss Daniel
    // (…wy-s-s d-a-n-i-el). Every letter is present, in order — which is the whole trick, and
    // why the word-start rule has to hold at every length, not just at two.
    const crew: JournalLink[] = [
      { name: 'Schneider Melanie', kind: 'person', present: true },
      { name: 'Wyss Daniel', kind: 'person', present: true },
    ]
    expect(suggestLinks('sani', crew)).toEqual([])
    expect(suggestLinks('schnei', crew).map((l) => l.name)).toEqual(['Schneider Melanie'])
  })

  it('⚠️ folds umlauts the same way the score does — «olbind» still reaches «Ölbinder»', () => {
    // the word-start check and fuzzyScore normalise separately; if they disagreed, a term could
    // score well and be thrown out again by the check that is supposed to qualify it
    expect(suggestLinks('3 Sack olbind', vocab).map((l) => l.kind)).toEqual(['material'])
  })

  it('⚠️ stops offering a term once it is written out — a second tap wrote it twice', () => {
    // a full name is two words, so the word under the cursor still matches after accepting
    expect(suggestLinks('Baumann Michael', vocab).map((l) => l.name)).not.toContain('Baumann Michael')
  })

  // ⚠️ …but a SINGLE-word term is the word being typed, not one already written out. «EL» was
  // suppressed by its own two letters, so the chip row offered «Stv. EL» — the other post — as the
  // answer to typing «el», which is how «EL Stv.» ends up in a Verlauf.
  it('keeps offering a one-word term while it is being typed, and stops once it is accepted', () => {
    const posts: JournalLink[] = [
      { name: 'EL', kind: 'person', word: true },
      { name: 'Stv. EL', kind: 'person', word: true },
    ]
    expect(suggestLinks('EL', posts).map((l) => l.name)).toContain('EL')
    expect(suggestLinks('EL', posts).map((l) => l.name)[0]).toBe('EL')
    expect(suggestLinks('EL ', posts).map((l) => l.name)).not.toContain('EL')
  })

  it('breaks a score tie on who is actually here', () => {
    const tie: JournalLink[] = [
      { name: 'Brunner Thomas', kind: 'person', present: false },
      { name: 'Brunner Peter', kind: 'person', present: true },
    ]
    expect(suggestLinks('Brunner', tie).map((l) => l.name)[0]).toBe('Brunner Peter')
  })

  it('replaces the word and leaves a space to keep writing', () => {
    expect(acceptName('Meier meldet Baum', 'Baumann Michael')).toBe('Meier meldet Baumann Michael ')
    expect(acceptName('', 'TLF')).toBe('TLF ')
  })

  it('reads the word under the cursor, not the sentence', () => {
    expect(currentWord('Meier meldet Baum')).toBe('Baum')
    expect(currentWord('Meier ')).toBe('')
  })
})
