import { describe, expect, it } from 'vitest'
import type { JournalLink } from './journalLinks'
import { journalVocabulary, linkMarkup, linkParts, linkRanges } from './journalLinks'
import type { AttendanceState, Person } from '../types'

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

  // ⚠️ The command posts are the one term short enough to hide inside ordinary words — and the
  // words it hides in are exactly the ones a Verlauf is full of.
  describe('a `word` term (EL, Stv. EL)', () => {
    const withEl: JournalLink[] = [...vocab, { name: 'EL', kind: 'person', word: true, role: 'Widmer Céline' }]

    it('marks it standing on its own, and carries the holder as its suffix', () => {
      const r = linkRanges('EL → Sanität: Lage stabil', withEl)
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ start: 0, end: 2, role: 'Widmer Céline' })
    })

    it('does NOT mark it inside Melder, Keller, Schnellangriff or Winkel', () => {
      expect(linkRanges('Melder 3 im Keller, Schnellangriff am Winkel', withEl)).toEqual([])
    })

    it('still marks it against punctuation, which is where it usually stands', () => {
      expect(linkRanges('Rückmeldung an EL, Trupp 2 zurück', withEl)).toHaveLength(1)
      expect(linkRanges('(EL)', withEl)).toHaveLength(1)
    })
  })
})

// An entry carries the odd address — the Meldung's ticket, a Merkblatt, the Wetterradar somebody
// was reading off. It is prose while it is typed and a link everywhere it is read.
describe('addresses', () => {
  it('finds both spellings, and gives the bare «www.» its scheme', () => {
    const urls = linkParts('Merkblatt https://vkf.ch/a und www.wetter.ch', vocab).filter((p) => p.kind === 'url')
    expect(urls.map((u) => u.text)).toEqual(['https://vkf.ch/a', 'www.wetter.ch'])
    expect(urls.map((u) => u.href)).toEqual(['https://vkf.ch/a', 'https://www.wetter.ch'])
  })

  it('leaves the sentence its own punctuation', () => {
    const one = (text: string) => linkParts(text, vocab).find((p) => p.kind === 'url')?.text
    expect(one('siehe www.vkf.ch.')).toBe('www.vkf.ch')
    expect(one('siehe www.vkf.ch, danach Rückzug')).toBe('www.vkf.ch')
    expect(one('siehe (www.vkf.ch)')).toBe('www.vkf.ch')
    expect(one('siehe «www.vkf.ch»')).toBe('www.vkf.ch')
  })

  it('…but keeps a bracket the address itself opened', () => {
    expect(linkParts('https://de.wikipedia.org/wiki/Nirvana_(Band).', vocab).find((p) => p.kind === 'url')?.text)
      .toBe('https://de.wikipedia.org/wiki/Nirvana_(Band)')
  })

  it('ignores a scheme with nothing behind it — somebody half-way through typing', () => {
    expect(linkRanges('Adresse folgt: https://.', vocab)).toEqual([])
  })

  it('⚠️ wins against the vocabulary — a Fahrzeug «TLF» must not bold up mid-link', () => {
    const parts = linkParts('Plan unter https://example.com/TLF/plan', vocab)
    expect(parts.filter((p) => p.kind).map((p) => p.kind)).toEqual(['url'])
  })
})

// Where a Meldung's callback number actually lands: in the sentence somebody typed. It is worth
// anchoring on the Rapport — and worth NOT guessing at, because a Verlauf is full of numbers that
// are not numbers to call.
describe('phone numbers', () => {
  const phones = (text: string) =>
    linkParts(text, vocab, { phone: true }).filter((p) => p.kind === 'phone')

  it('finds the shapes a Swiss number is written in, and normalises the href', () => {
    const cases: [string, string][] = [
      ['079 123 45 67', 'tel:0791234567'],
      ['+41 79 123 45 67', 'tel:+41791234567'],
      ['044 123 45 67', 'tel:0441234567'],
      ['079/123 45 67', 'tel:0791234567'],
      ['079.123.45.67', 'tel:0791234567'],
      ['079-123-45-67', 'tel:0791234567'],
      ['0791234567', 'tel:0791234567'],
    ]
    for (const [typed, href] of cases) {
      const hit = phones(`Melder ${typed}, wartet vor dem Haus`)
      expect(hit, typed).toHaveLength(1)
      // the printed text stays exactly as it was typed — the Rapport prints what was said
      expect(hit[0].text).toBe(typed)
      expect(hit[0].href).toBe(href)
    }
  })

  it('⚠️ swallows nothing that merely looks numeric', () => {
    const nothing = [
      'Rückzug 14:31, Wiederbelebung ab 14:31:20',
      'Flasche 250 bar, zweite 300 bar',
      'Leitung 3 ab Verteiler 2, Ltg-Nr 12',
      'Ereignis vom 01.09.2026, Nachkontrolle 04.09.2026',
      'Zählerstand 20260901123456 abgelesen',
    ]
    for (const text of nothing) expect(phones(text), text).toEqual([])
  })

  it('⚠️ leaves the digits inside an address alone — that link is already claimed', () => {
    const text = 'Meldung unter https://elz.ch/f/0791234567 abgelegt'
    const parts = linkParts(text, vocab, { phone: true }).filter((p) => p.kind)
    expect(parts.map((p) => p.kind)).toEqual(['url'])
  })

  it('⚠️ is not marked on screen — the Verlauf renders a number as prose', () => {
    expect(linkParts('Melder 079 123 45 67', vocab).some((p) => p.kind)).toBe(false)
  })

  it('anchors it for the PDF, underlined like an address', () => {
    expect(linkMarkup('Melder 079 123 45 67 vor dem Haus', vocab, (v) => v))
      .toBe('Melder <a href="tel:0791234567"><u>079 123 45 67</u></a> vor dem Haus')
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

  it('anchors an address and underlines it — the Rapport has no colour to spend', () => {
    expect(linkMarkup('Merkblatt www.vkf.ch beachten', vocab, (v) => v))
      .toBe('Merkblatt <a href="https://www.vkf.ch"><u>www.vkf.ch</u></a> beachten')
  })

  it('⚠️ escapes the href too — one raw «&» between query parameters costs the whole page', () => {
    expect(linkMarkup('https://a.ch/x?a=1&b=2', vocab, (v) => v.replace(/&/g, '&amp;')))
      .toBe('<a href="https://a.ch/x?a=1&amp;b=2"><u>https://a.ch/x?a=1&amp;b=2</u></a>')
  })

  it('⚠️ says nothing at all when the row marked nothing — the backend escapes the text itself', () => {
    expect(linkMarkup('Kellerbrand bestätigt', vocab, (v) => v)).toBeUndefined()
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

// ⚠️ Both directions of one fact: the person's entry prints «Widmer Céline (EL)», the post's
// entry prints «EL (Widmer Céline)» — so it does not matter which way round the sentence is
// written. And when nobody holds the post, «EL» is still what was said on the radio.
describe('journalVocabulary · the command posts', () => {
  const person = (id: string, displayName: string): Person => ({ id, displayName, active: true, updatedAt: '2026-08-17T20:00:00.000Z' })
  const present = (displayNameSnapshot: string, note?: string) =>
    ({ status: 'present' as const, displayNameSnapshot, note, intervals: [{ from: '2026-08-17T20:00:00.000Z' }] })

  const personnel = [person('p1', 'Widmer Céline'), person('p2', 'Meier Anna')]
  const attendance: AttendanceState = {
    p1: present('Widmer Céline', 'Einsatzleiter'),
    p2: present('Meier Anna'),
  }

  it('resolves EL to whoever holds it, in both directions', () => {
    const vocab = journalVocabulary(personnel, attendance)
    expect(vocab.find((l) => l.name === 'EL')).toMatchObject({ role: 'Widmer Céline', word: true })
    expect(vocab.find((l) => l.name === 'Widmer Céline')).toMatchObject({ role: 'EL' })
  })

  it('keeps the term when nobody holds the post — there is simply nobody to name yet', () => {
    const vocab = journalVocabulary(personnel, { p2: present('Meier Anna') })
    const el = vocab.find((l) => l.name === 'EL')
    expect(el).toBeTruthy()
    expect(el?.role).toBeUndefined()
    expect(linkParts('EL → Sanität', vocab).find((p) => p.kind)?.text).toBe('EL')
  })
})

// ⚠️ A handover leaves the previous EL's Bemerkung standing (the app warns, it does not overwrite
// what somebody wrote). Without a time the answer came out of the roster sort, so the journal could
// keep naming the person who handed over an hour ago.
describe('journalVocabulary · who holds the post NOW', () => {
  const person = (id: string, displayName: string): Person =>
    ({ id, displayName, active: true, updatedAt: '2026-08-18T20:00:00.000Z' })
  const el = (displayNameSnapshot: string, noteAt?: string) =>
    ({ status: 'present' as const, displayNameSnapshot, note: 'Einsatzleiter', noteAt, intervals: [{ from: '2026-08-18T20:00:00.000Z' }] })

  it('names the one who took it on last', () => {
    const vocab = journalVocabulary(
      [person('p1', 'Aebi Anna'), person('p2', 'Zünd Beat')],
      { p1: el('Aebi Anna', '2026-08-18T20:10:00.000Z'), p2: el('Zünd Beat', '2026-08-18T21:30:00.000Z') },
    )
    expect(vocab.find((l) => l.name === 'EL')?.role).toBe('Zünd Beat')
  })

  it('sorts an entry with no stamp last — those are the old ones', () => {
    const vocab = journalVocabulary(
      [person('p1', 'Aebi Anna'), person('p2', 'Zünd Beat')],
      { p1: el('Aebi Anna'), p2: el('Zünd Beat', '2026-08-18T21:30:00.000Z') },
    )
    expect(vocab.find((l) => l.name === 'EL')?.role).toBe('Zünd Beat')
  })
})
