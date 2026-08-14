import { describe, expect, it } from 'vitest'
import { isOpenableUrl, linkTokenValues, resolveLinkUrl } from './reportLinks'

// The shape a Google Form's prefill link has — its field ids as query parameters. The ids here
// are made up: a real station's belong in that station's config, never in this repo.
const GFORM = 'https://forms.example.ch/getraenke?usp=pp_url'
  + '&entry.111111111={einsatzleiter}&entry.222222222={stichwort}, {ort} – {datum}'

// ⚠️ Built from LOCAL wall-clock parts, not from a `Z` literal. The tokens render through
// `toLocaleDateString`, so a fixed UTC instant lands on a different calendar day depending on
// where the machine is — `TZ=Asia/Tokyo` turned 14.08. into 15.08. and failed the suite for a
// developer while staying green on the UTC CI runner, which is the worse way round.
const local = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).toISOString()

const FACTS = {
  stichwort: 'Brand Gebäude',
  ort: 'Musterstrasse 3',
  alarmiertAt: local(2026, 8, 14, 19, 42),
  endedAt: local(2026, 8, 14, 21, 5),
  einsatzleiter: 'Hans Muster',
  wehr: 'Feuerwehr Musterdorf',
}

describe('linkTokenValues', () => {
  it('gives {datum} the day and the two instants their date, so a multi-day Einsatz stays readable', () => {
    const v = linkTokenValues(FACTS)
    expect(v.datum).toBe('14.08.2026')
    // the instants carry the date AND a time — «07:20» alone cannot say which morning it was
    expect(v.alarmzeit).toBe('14.08.2026, 19:42')
    expect(v.einsatzende).toBe('14.08.2026, 21:05')
  })

  it('resolves a field nobody has filled in yet to an empty string, never «undefined»', () => {
    const v = linkTokenValues({ stichwort: 'Brand' })
    expect(v.einsatzleiter).toBe('')
    expect(v.datum).toBe('')
    expect(v.einsatzende).toBe('')
  })
})

describe('resolveLinkUrl', () => {
  it('encodes what it substitutes, so an Umlaut and a space survive the query string', () => {
    const url = resolveLinkUrl(GFORM, linkTokenValues(FACTS))
    expect(url).toContain('entry.111111111=Hans%20Muster')
    expect(url).toContain('entry.222222222=Brand%20Geb%C3%A4ude')
    expect(url).not.toContain('{')
  })

  it('leaves the separators the station typed BETWEEN tokens alone', () => {
    // …because the same string carries the `&` and `=` that hold the query together: encoding
    // the literal text would take the URL apart. Only the values are encoded.
    const url = resolveLinkUrl(GFORM, linkTokenValues(FACTS))
    expect(url).toContain('?usp=pp_url&entry.111111111=')
    expect(url).toContain('Musterstrasse%203 – 14.08.2026')
  })

  it('leaves an unknown token standing, so a typo is visible instead of a silently blank field', () => {
    expect(resolveLinkUrl('https://x/?a={einsatzort}', linkTokenValues(FACTS)))
      .toBe('https://x/?a={einsatzort}')
  })

  it('drops an empty value without leaving the braces behind', () => {
    expect(resolveLinkUrl('https://x/?el={einsatzleiter}', linkTokenValues({})))
      .toBe('https://x/?el=')
  })
})

describe('isOpenableUrl', () => {
  it('accepts http(s) — including one that still carries its placeholders', () => {
    expect(isOpenableUrl('https://example.ch/f?a={ort}')).toBe(true)
    expect(isOpenableUrl('http://example.ch')).toBe(true)
  })

  it('refuses anything that is not a fetchable page', () => {
    // the reason this gate exists: the URL comes from the config document
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableUrl('/relativ')).toBe(false)
    expect(isOpenableUrl('')).toBe(false)
  })
})
