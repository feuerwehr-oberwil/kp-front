import { describe, expect, it } from 'vitest'
import { softHyphenate, softHyphenateText } from './symbolWrap'
import { getCopy } from '../config/copy'

const SHY = '­'
const strip = (s: string) => s.replaceAll(SHY, '')

describe('softHyphenate', () => {
  it('breaks a compound at its component boundary, not by syllable', () => {
    expect(softHyphenate('Drohnenlandeplatz')).toBe(`Drohnen${SHY}lande${SHY}platz`)
    expect(softHyphenate('Angehörigensammelstelle')).toBe(`Angehörigen${SHY}sammel${SHY}stelle`)
  })

  it('leaves a word that is not in the table alone', () => {
    expect(softHyphenate('Forst')).toBe('Forst')
  })

  // ⚠️ The seam value is a DISPLAY label. A dropped or duplicated letter in it ships a
  // misspelled symbol name to the palette, and a soft hyphen is invisible in review — so the
  // whole table is checked against itself rather than read.
  it('never changes a label beyond inserting soft hyphens', () => {
    const names = Object.values(getCopy().symbolNames)
    for (const name of names) expect(strip(softHyphenate(name))).toBe(name)
  })

  // The bug this table exists for: without a seam the palette cell CLIPS rather than wraps —
  // «Drohnenlandeplatz» read as «Drohnenlandeplat» in the field (01.09.).
  it('gives every symbol label long enough to clip somewhere to break', () => {
    const unseamed = Object.values(getCopy().symbolNames)
      .filter((name) => name.length >= 14 && !name.includes(' ') && !softHyphenate(name).includes(SHY))
    expect(unseamed).toEqual([])
  })
})

describe('softHyphenateText', () => {
  it('seams each word of a free-text caption on its own', () => {
    expect(softHyphenateText('Salpetersäure, rauchend')).toBe(`Salpeter${SHY}säure, rauchend`)
  })

  it('keeps a multi-line caption intact', () => {
    expect(strip(softHyphenateText('CO₂\n1200 l/min'))).toBe('CO₂\n1200 l/min')
  })
})
