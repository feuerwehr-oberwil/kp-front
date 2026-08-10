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

// A Verlauf full of surnames tells a reader who was talking only if they already know the Wehr.
// Six months later, or on a Nachbarwehr's copy of the Rapport, nobody does.
describe('the job after the name', () => {
  const withRoles: JournalLink[] = [
    { name: 'Widmer Céline', kind: 'person', id: 'p1', role: 'EL' },
    { name: 'Graf Stefan', kind: 'person', id: 'p2', role: 'Fahrer TLF' },
    { name: 'Meier Anna', kind: 'person', id: 'p3' },
  ]

  it('names the role after the person it belongs to', () => {
    const parts = linkParts('Rückmeldung an ELZ durch Widmer Céline', withRoles)
    expect(parts.find((p) => p.kind)?.role).toBe('EL')
  })

  it('says it ONCE per entry — a row that repeats itself reads as a bug', () => {
    const parts = linkParts('Widmer Céline meldet, Widmer Céline übernimmt', withRoles)
    const marked = parts.filter((p) => p.kind)
    expect(marked).toHaveLength(2)
    expect(marked[0].role).toBe('EL')
    expect(marked[1].role).toBeUndefined()
  })

  it('leaves somebody without a job exactly as they were', () => {
    expect(linkParts('Meier Anna meldet', withRoles).find((p) => p.kind)?.role).toBeUndefined()
  })

  it('prints the role in plain weight beside the bold name', () => {
    expect(linkMarkup('Graf Stefan meldet', withRoles, (x) => x))
      .toBe('<b>Graf Stefan</b> (Fahrer TLF) meldet')
  })
})
