import { describe, expect, it } from 'vitest'
import type { JournalLink } from './journalLinks'
import { linkMarkup, linkParts, linkRanges } from './journalLinks'

const vocab: JournalLink[] = [
  { name: 'Meier', kind: 'person' },
  { name: 'Meier Anna', kind: 'person' },
  { name: 'TLF', kind: 'vehicle' },
  { name: 'Ölbinder', kind: 'material' },
  { name: 'Gr. 1 (Kdo)', kind: 'group' },
]

describe('linkRanges', () => {
  it('⚠️ takes the LONGEST match, so «Meier» inside «Meier Anna» cannot claim half of it', () => {
    const text = 'Meier Anna meldet'
    const r = linkRanges(text, vocab)
    expect(r).toHaveLength(1)
    expect(text.slice(r[0].start, r[0].end)).toBe('Meier Anna')
  })

  it('finds every kind, in reading order', () => {
    const text = 'TLF bringt Ölbinder, Gr. 1 (Kdo) alarmiert'
    expect(linkRanges(text, vocab).map((r) => r.kind)).toEqual(['vehicle', 'material', 'group'])
  })

  it('matches whatever case was typed at 3am', () => {
    expect(linkRanges('tlf unterwegs', vocab).map((r) => r.kind)).toEqual(['vehicle'])
  })

  it('marks nothing in a sentence that names nothing', () => {
    expect(linkRanges('Kellerbrand bestätigt', vocab)).toEqual([])
  })
})

describe('linkParts', () => {
  it('splits into plain and marked stretches that rebuild the original exactly', () => {
    const text = 'TLF bringt Ölbinder'
    const parts = linkParts(text, vocab)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.kind).map((p) => p.text)).toEqual(['TLF', 'Ölbinder'])
  })
})

describe('linkMarkup', () => {
  it('bolds the links for the PDF', () => {
    expect(linkMarkup('TLF bringt Ölbinder', vocab, (v) => v))
      .toBe('<b>TLF</b> bringt <b>Ölbinder</b>')
  })

  it('⚠️ escapes everything that is not our own markup — a typed «&» must not break the row', () => {
    expect(linkMarkup('TLF & Pio', vocab, (v) => v.replace(/&/g, '&amp;')))
      .toBe('<b>TLF</b> &amp; Pio')
  })
})
