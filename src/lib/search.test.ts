import { describe, expect, it } from 'vitest'
import { matchesAnyQuery, matchesRaw, searchQuery, withinOneEdit } from './search'

// The two things every picker's search box forgives. Written against the names that actually
// caused it: a Divera roster spelling «Müller» while the on-screen keyboard offers «Mueller»,
// and a gloved thumb hitting the letter beside the one it meant.

describe('umlauts, both directions', () => {
  it('finds the umlaut spelling from the transliterated one', () => {
    expect(matchesRaw('mueller', 'Müller Hans')).toBe(true)
    expect(matchesRaw('kaefer', 'Käfer Anna')).toBe(true)
  })

  it('…and the transliterated spelling from the umlaut one', () => {
    expect(matchesRaw('müller', 'Mueller Hans')).toBe(true)
  })
})

describe('one typo', () => {
  it.each([
    ['widemr', 'transposed'],
    ['widmr', 'a letter missing'],
    ['widmerr', 'a letter too many'],
    ['widner', 'the wrong letter'],
  ])('«%s» still finds Widmer (%s)', (q) => {
    expect(matchesRaw(q, 'Widmer Céline')).toBe(true)
  })

  it('forgives a typo in the second name too — accents folded away with it', () => {
    expect(matchesRaw('celine', 'Widmer Céline')).toBe(true)
    expect(matchesRaw('celnie', 'Widmer Céline')).toBe(true)
  })

  it('does not forgive two', () => {
    expect(matchesRaw('widnre', 'Widmer Céline')).toBe(false)
  })

  it('stays literal on a short query — one typo in three letters matches half the Mannschaft', () => {
    expect(matchesRaw('mei', 'Beispiel Anna')).toBe(false)
    expect(matchesRaw('mei', 'Meier Anna')).toBe(true)
  })

  it('only at a word start: a typo inside a fragment is not a name somebody meant', () => {
    expect(matchesRaw('ueller', 'Müller Hans')).toBe(true) // exact fragment, still fine
    expect(matchesRaw('uellor', 'Müller Hans')).toBe(false)
  })

  it('leaves a multi-word query literal', () => {
    expect(matchesRaw('müller hans', 'Müller Hans')).toBe(true)
    expect(matchesRaw('müller hnas', 'Müller Hans')).toBe(false)
  })

  it('an empty query matches everything, as an unsearched list should', () => {
    expect(matchesRaw('   ', 'Müller Hans')).toBe(true)
  })
})

describe('withinOneEdit', () => {
  it.each([
    ['meier', 'meier', true],
    ['meier', 'meiier', true],
    ['meier', 'meer', true],
    ['meier', 'maier', true],
    ['meier', 'mieer', true],
    ['meier', 'mayer', false],
    ['meier', 'me', false],
  ])('%s ~ %s → %s', (a, b, expected) => {
    expect(withinOneEdit(a, b)).toBe(expected)
    expect(withinOneEdit(b, a)).toBe(expected)
  })
})

// The reported bug (16.09.2026): the object picker found «BLT Tramdepot» but not «Grenzweg»,
// the street it stands on — an alarm names whichever of the two the caller knows.
describe('matchesAnyQuery — name OR address', () => {
  const q = (raw: string) => searchQuery(raw)!
  const depot = ['BLT Tramdepot', 'Grenzweg 1'] as const

  it('finds the object by its name and by its address', () => {
    expect(matchesAnyQuery(q('blt'), ...depot)).toBe(true)
    expect(matchesAnyQuery(q('grenzweg'), ...depot)).toBe(true)
  })

  it('forgives the one typo in either field', () => {
    expect(matchesAnyQuery(q('grenwzeg'), ...depot)).toBe(true)
  })

  it('an object without an address is matched on what it has', () => {
    expect(matchesAnyQuery(q('werkhof'), 'Werkhof', null)).toBe(true)
    expect(matchesAnyQuery(q('grenzweg'), 'Werkhof', null)).toBe(false)
  })
})
