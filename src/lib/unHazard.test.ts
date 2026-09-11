import { describe, expect, it } from 'vitest'
import raw from '../../public/un-hazard.json'
import { allEntries, lookupUN, normalizeUN, decodeKemler, lookupUNByName, allStoffNames, __setUnHazardData, type UnHazardEntry } from './unHazard'

// The dataset is a fetched static asset now (lib/staticData): capture the pre-load
// behaviour first — lookups MISS, they never throw — then inject the real data the way
// the boot prefetch would.
const beforeLoad = { hit: lookupUN('1203'), names: allStoffNames().length, all: allEntries().length }
__setUnHazardData(raw as UnHazardEntry[])

describe('before the dataset lands', () => {
  it('every lookup misses instead of throwing', () => {
    expect(beforeLoad.hit).toBeNull()
    expect(beforeLoad.names).toBe(0)
    expect(beforeLoad.all).toBe(0)
  })
})

describe('decodeKemler', () => {
  it('flags the water-reactive "X" prefix', () => {
    const r = decodeKemler('X423')
    expect(r?.reactsWithWater).toBe(true)
    expect(r?.hazards).toContain('Entzündbarer fester Stoff')
  })

  it('decodes a plain flammable-liquid code and intensification', () => {
    const r = decodeKemler('33')
    expect(r?.reactsWithWater).toBe(false)
    expect(r?.hazards[0]).toMatch(/Entzündbarer flüssiger/)
    expect(r?.hazards.some((h) => /Verstärkte/.test(h))).toBe(true)
  })

  it('ignores a trailing 0 (no additional hazard)', () => {
    const r = decodeKemler('60')
    expect(r?.hazards).toEqual(['Giftig / Ansteckungsgefahr'])
  })

  it('returns null for empty / non-numeric input', () => {
    expect(decodeKemler(null)).toBeNull()
    expect(decodeKemler('')).toBeNull()
    expect(decodeKemler('abc')).toBeNull()
  })
})

describe('normalizeUN', () => {
  it('strips a UN prefix, spaces and leading zeros', () => {
    expect(normalizeUN('UN 1203')).toBe('1203')
    expect(normalizeUN('un-1203')).toBe('1203')
    expect(normalizeUN(' 0004 ')).toBe('4')
    expect(normalizeUN('1203')).toBe('1203')
  })
})

describe('lookupUN', () => {
  it('finds Benzin / petrol (UN 1203)', () => {
    const e = lookupUN('1203')
    expect(e).not.toBeNull()
    expect(e!.name_de).toMatch(/BENZIN/i)
    expect(e!.class).toBe('3')
    expect(e!.hazardNumber).toBe('33')
    expect(e!.packingGroup).toBe('II')
    expect(e!.hazardLabels).toContain('3')
  })

  it('finds Chlor / chlorine (UN 1017)', () => {
    const e = lookupUN('1017')
    expect(e!.name_de).toBe('CHLOR')
    expect(e!.class).toBe('2')
    expect(e!.hazardNumber).toBe('265')
    expect(e!.hazardLabels).toEqual(['2.3', '5.1', '8'])
  })

  it('finds LPG / liquefied hydrocarbon gas (UN 1965)', () => {
    const e = lookupUN('1965')
    expect(e!.class).toBe('2')
    expect(e!.hazardNumber).toBe('23')
    expect(e!.hazardLabels).toContain('2.1')
  })

  it('finds Aceton / acetone (UN 1090)', () => {
    const e = lookupUN('1090')
    expect(e!.name_de).toBe('ACETON')
    expect(e!.hazardNumber).toBe('33')
  })

  it('accepts a "UN ..." prefixed query', () => {
    expect(lookupUN('UN 1203')?.un).toBe('1203')
  })

  it('preserves leading zeros in the un field and matches them', () => {
    const e = lookupUN('0004')
    expect(e).not.toBeNull()
    expect(e!.un).toBe('0004')
    expect(e!.class).toBe('1')
  })

  it('returns null for unknown / empty input', () => {
    expect(lookupUN('9999999')).toBeNull()
    expect(lookupUN('')).toBeNull()
  })
})

describe('dataset integrity', () => {
  const data = allEntries()

  it('has broad coverage (thousands of entries)', () => {
    expect(data.length).toBeGreaterThan(2000)
  })

  it('every entry has a 1–4 digit un and an array of hazard labels', () => {
    for (const e of data) {
      expect(e.un).toMatch(/^\d{1,4}$/)
      expect(Array.isArray(e.hazardLabels)).toBe(true)
    }
  })

  it('has no duplicate UN numbers', () => {
    const uns = data.map((e) => e.un)
    expect(new Set(uns).size).toBe(uns.length)
  })
})

/* The reverse lookup (Feldtest Manuel, 07.09.): the Stoff field resolves by NAME. Exact and
 * case/whitespace-insensitive only — a fuzzy hit here would put a wrong UN, and with it wrong
 * ERG distances, on the map. */
describe('lookupUNByName / allStoffNames', () => {
  it('resolves an official German name, case-insensitively', () => {
    expect(lookupUNByName('METHYLAMYLACETAT')?.un).toBe('1233')
    expect(lookupUNByName('  methylamylacetat ')?.un).toBe('1233')
  })

  it('refuses what it does not know exactly', () => {
    expect(lookupUNByName('Methylamyl')).toBeNull()
    expect(lookupUNByName('')).toBeNull()
  })

  it('offers every distinct name, sorted, as the search corpus', () => {
    const names = allStoffNames()
    expect(names.length).toBeGreaterThan(2000)
    expect(names).toContain('METHYLAMYLACETAT')
    // sorted de-CH and deduplicated
    expect([...names].sort((a, b) => a.localeCompare(b, 'de-CH'))).toEqual([...names])
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
  })
})
