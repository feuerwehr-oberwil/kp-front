import { describe, it, expect } from 'vitest'
import type { MittelEntry } from '../types'
import {
  mittelKey, deriveCurrentMittel, visibleMittel, recordedMittel, currentMengeFor,
  groupBySource, groupByMaterial, mittelReportRows, mittelLineCount,
  availableFor, mittelListGroups, groupCatalogue,
  materialForSymbol, currentLineFor, defaultSourceFor, symbolCaptureConfigured,
} from './mittel'
import type { DeploymentMittelItem, DeploymentMittelSource } from './deploymentConfig'

const NO_SRC = 'Ohne Quelle'

// helper: build an event with a monotonically increasing timestamp by index
function ev(i: number, p: Partial<MittelEntry>): MittelEntry {
  return {
    id: `m${i}`,
    label: 'Lüfter', unit: 'Stk', menge: 1,
    at: `2026-06-30T10:0${i}:00.000Z`,
    ...p,
  }
}

describe('mittelKey', () => {
  it('keys on material + unit + source', () => {
    expect(mittelKey({ materialId: 'l', label: 'Lüfter', unit: 'Stk', sourceId: 'tlf' }))
      .toBe('l|stk|tlf')
  })
  it('falls back to labels for custom material/source and is case-insensitive', () => {
    expect(mittelKey({ label: 'Schaummittel', unit: 'l', sourceLabel: 'Depot' }))
      .toBe('~schaummittel|l|~depot')
  })
  it('separates the same material recorded in different units', () => {
    expect(mittelKey({ materialId: 'l', label: 'L', unit: 'Stk' }))
      .not.toBe(mittelKey({ materialId: 'l', label: 'L', unit: 'l' }))
  })
})

describe('deriveCurrentMittel', () => {
  it('keeps only the latest event per key, regardless of array order', () => {
    const log = [
      ev(2, { materialId: 'l', menge: 3, sourceId: 'tlf' }),
      ev(1, { materialId: 'l', menge: 1, sourceId: 'tlf' }), // older, listed after
    ]
    const cur = deriveCurrentMittel(log)
    expect(cur.get('l|stk|tlf')?.menge).toBe(3)
    expect(cur.get('l|stk|tlf')?.entryId).toBe('m2')
  })
})

describe('visibleMittel', () => {
  it('drops zeroed (tombstone) lines but keeps their history available', () => {
    const log = [
      ev(1, { materialId: 'l', menge: 2, sourceId: 'tlf' }),
      ev(2, { materialId: 'l', menge: 0, sourceId: 'tlf' }), // later zero hides it
    ]
    expect(visibleMittel(log)).toHaveLength(0)
    expect(deriveCurrentMittel(log).get('l|stk|tlf')?.menge).toBe(0) // history still derivable
  })
  it('counts distinct visible lines', () => {
    const log = [
      ev(1, { materialId: 'l', menge: 2, sourceId: 'tlf' }),
      ev(2, { materialId: 'l', menge: 1, sourceId: 'lf' }),
    ]
    expect(mittelLineCount(log)).toBe(2)
  })
})

describe('currentMengeFor (no-op detection)', () => {
  it('returns the running total for a key, 0 when never recorded', () => {
    const log = [ev(1, { materialId: 'l', menge: 4, sourceId: 'tlf' })]
    expect(currentMengeFor(log, { materialId: 'l', label: 'Lüfter', unit: 'Stk', sourceId: 'tlf' })).toBe(4)
    expect(currentMengeFor(log, { materialId: 'l', label: 'Lüfter', unit: 'Stk', sourceId: 'lf' })).toBe(0)
  })
})

describe('groupBySource', () => {
  it('groups source-first and sinks the no-source bucket to the bottom', () => {
    const cur = visibleMittel([
      ev(1, { materialId: 'l', label: 'Lüfter', menge: 1, sourceId: 'tlf', sourceLabel: 'TLF' }),
      ev(2, { materialId: 's', label: 'Schaum', unit: 'l', menge: 5 }), // no source
    ])
    const groups = groupBySource(cur, NO_SRC)
    expect(groups.map((g) => g.sourceLabel)).toEqual(['TLF', NO_SRC])
    expect(groups[1].hasSource).toBe(false)
  })
})

describe('groupByMaterial / mittelReportRows', () => {
  it('sums a material across sources and lists the sources', () => {
    const log = [
      ev(1, { materialId: 'l', label: 'Lüfter', menge: 1, sourceId: 'tlf', sourceLabel: 'TLF' }),
      ev(2, { materialId: 'l', label: 'Lüfter', menge: 1, sourceId: 'lf', sourceLabel: 'LF' }),
    ]
    const rows = mittelReportRows(log, NO_SRC)
    expect(rows).toHaveLength(1)
    expect(rows[0].total).toBe(2)
    expect(rows[0].sources).toEqual(['LF', 'TLF']) // alphabetical
  })
  it('does not merge the same material across different units', () => {
    const rows = groupByMaterial(visibleMittel([
      ev(1, { materialId: 'l', label: 'Lüfter', unit: 'Stk', menge: 1 }),
      ev(2, { materialId: 'l', label: 'Lüfter', unit: 'h', menge: 3 }),
    ]), NO_SRC)
    expect(rows).toHaveLength(2)
  })
})

const CATALOGUE: DeploymentMittelItem[] = [
  { id: 'oelbinder', label: 'Ölbinder', unit: 'Sack', category: 'Ölwehr' },
  { id: 'luefter', label: 'Lüfter', unit: 'Stk', category: 'Geräte', stock: [{ source: 'tlf', qty: 2 }, { source: 'pio', qty: 1 }] },
  { id: 'wbk', label: 'Wärmebildkamera', unit: 'Stk', category: 'Geräte', stock: [{ source: 'tlf', qty: 1 }] },
]
const SOURCES: DeploymentMittelSource[] = [
  { id: 'tlf', label: 'TLF' }, { id: 'pio', label: 'Pio' }, { id: 'mowa', label: 'MoWa' },
]

describe('availableFor', () => {
  it('returns the per-source stock; 0 for a source the item lists no stock at', () => {
    expect(availableFor(CATALOGUE, 'luefter', 'tlf')).toBe(2)
    expect(availableFor(CATALOGUE, 'luefter', 'mowa')).toBe(0) // has stock config, not at mowa
  })
  it('returns undefined when the item carries no stock config or no source given', () => {
    expect(availableFor(CATALOGUE, 'oelbinder', 'tlf')).toBeUndefined()
    expect(availableFor(CATALOGUE, 'luefter', undefined)).toBeUndefined()
  })
})

describe('mittelListGroups (unified stepper list)', () => {
  const LABELS = { other: 'Übrige', custom: 'Weitere' }
  it('lists the WHOLE catalogue (usage or not) grouped by category, with per-source cells', () => {
    const log = [
      ev(1, { materialId: 'luefter', label: 'Lüfter', menge: 1, sourceId: 'tlf', sourceLabel: 'TLF' }),
    ]
    const groups = mittelListGroups(log, CATALOGUE, SOURCES, LABELS)
    expect(groups.map((g) => g.category)).toEqual(['Ölwehr', 'Geräte'])
    const luefter = groups[1].rows.find((r) => r.key === 'luefter')!
    expect(luefter.totalStock).toBe(3)
    expect(luefter.totalUsed).toBe(1)
    expect(luefter.cells).toHaveLength(2) // TLF + Pio stock cells
    const tlf = luefter.cells.find((c) => c.sourceId === 'tlf')!
    expect([tlf.stock, tlf.used]).toEqual([2, 1])
    // unused, unstocked catalogue item still renders — one empty no-source cell, no stock
    const oel = groups[0].rows.find((r) => r.key === 'oelbinder')!
    expect(oel.totalStock).toBeUndefined()
    expect(oel.cells).toEqual([{ used: 0 }])
  })
  it('keeps a zeroed catalogue line as a 0-cell (the row IS the catalogue, not the log)', () => {
    const log = [
      ev(1, { materialId: 'wbk', label: 'Wärmebildkamera', menge: 2, sourceId: 'tlf', sourceLabel: 'TLF' }),
      ev(2, { materialId: 'wbk', label: 'Wärmebildkamera', menge: 0, sourceId: 'tlf', sourceLabel: 'TLF' }),
    ]
    const groups = mittelListGroups(log, CATALOGUE, SOURCES, LABELS)
    const wbk = groups.find((g) => g.category === 'Geräte')!.rows.find((r) => r.key === 'wbk')!
    expect(wbk.totalUsed).toBe(0)
    expect(wbk.cells[0].used).toBe(0)
  })
  it('collects free-typed lines (and non-catalogue units) into the trailing custom group', () => {
    const log = [
      ev(1, { label: 'Sandsäcke', unit: 'Stk', menge: 25 }),                                  // no materialId
      ev(2, { materialId: 'luefter', label: 'Lüfter', unit: 'h', menge: 3 }),                 // unit mismatch
    ]
    const groups = mittelListGroups(log, CATALOGUE, SOURCES, LABELS)
    const custom = groups.find((g) => g.custom)!
    expect(custom.category).toBe('Weitere')
    expect(custom.rows.map((r) => r.label).sort()).toEqual(['Lüfter', 'Sandsäcke'])
    expect(custom.rows.every((r) => r.cells.length === 1)).toBe(true)
  })
  it('adds a usage-only cell for a source the item has no stock at (over-use visible)', () => {
    const log = [ev(1, { materialId: 'wbk', label: 'Wärmebildkamera', menge: 1, sourceId: 'mowa', sourceLabel: 'MoWa' })]
    const groups = mittelListGroups(log, CATALOGUE, SOURCES, LABELS)
    const wbk = groups.find((g) => g.category === 'Geräte')!.rows.find((r) => r.key === 'wbk')!
    expect(wbk.cells).toHaveLength(2) // TLF stock cell + MoWa usage cell
    const mowa = wbk.cells.find((c) => c.sourceId === 'mowa')!
    expect(mowa.used).toBe(1)
    expect(mowa.stock).toBeUndefined()
    expect(wbk.totalUsed).toBe(1)
  })
})

describe('groupCatalogue', () => {
  it('groups by category in config order, uncategorised last', () => {
    const cat: DeploymentMittelItem[] = [
      { id: 'a', label: 'A', category: 'Ölwehr' },
      { id: 'b', label: 'B' }, // uncategorised
      { id: 'c', label: 'C', category: 'Geräte' },
      { id: 'd', label: 'D', category: 'Ölwehr' },
    ]
    const groups = groupCatalogue(cat, 'Übrige')
    expect(groups.map((g) => g.category)).toEqual(['Ölwehr', 'Geräte', 'Übrige'])
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'd'])
  })
})

describe('materialForSymbol', () => {
  const CAT: DeploymentMittelItem[] = [
    { id: 'luefter', label: 'Lüfter', unit: 'Stk' },
    { id: 'leiter', label: 'Leiter', unit: 'Stk' },
    { id: 'oelsperre', label: 'Ölsperre', unit: 'm', symbol: 'FW Kleinloeschgeraet' },
  ]
  it('matches label tokens as whole words across umlaut/digraph spellings', () => {
    expect(materialForSymbol(CAT, 'VKF Luefter mobil')?.id).toBe('luefter')
    expect(materialForSymbol(CAT, 'FW Leiter')?.id).toBe('leiter')
  })
  it('never matches on substrings («Leiter» must not match «Einsatzleiter»)', () => {
    expect(materialForSymbol(CAT, 'VKF Einsatzleiter')).toBeUndefined()
    expect(materialForSymbol(CAT, 'VKF Drehleiter')).toBeUndefined()
  })
  it('an explicit catalogue symbol key wins over token matching', () => {
    expect(materialForSymbol(CAT, 'FW Kleinloeschgeraet')?.id).toBe('oelsperre')
  })
})

describe('status fold (data model — Retablierung UI retired 2026-07-14)', () => {
  it('the latest event carries the line status; a later event without status clears it', () => {
    const log = [
      ev(1, { materialId: 'luefter', menge: 1 }),
      ev(2, { materialId: 'luefter', menge: 1, status: 'defekt' }),
    ]
    expect(currentLineFor(log, { materialId: 'luefter', label: 'Lüfter', unit: 'Stk' })?.status).toBe('defekt')
    const cleared = [...log, ev(3, { materialId: 'luefter', menge: 1 })]
    expect(currentLineFor(cleared, { materialId: 'luefter', label: 'Lüfter', unit: 'Stk' })?.status).toBeUndefined()
  })
})

describe('recordedMittel (the sheet) vs visibleMittel (the Rapport)', () => {
  it('keeps a zeroed line on the sheet and off the Rapport', () => {
    // a hand-added line stepped back to 0 says «nothing used» — it must stay editable in the
    // list (rename, Bestand, delete) while stating nothing on the printed sheet
    const log = [
      ev(1, { label: 'Kettensägenöl', unit: 'l', menge: 2 }),
      ev(2, { label: 'Kettensägenöl', unit: 'l', menge: 0 }),
    ]
    expect(visibleMittel(log)).toHaveLength(0)
    expect(recordedMittel(log)).toHaveLength(1)
    expect(recordedMittel(log)[0]).toMatchObject({ label: 'Kettensägenöl', menge: 0 })
  })

  it('an explicit deletion takes the line off BOTH', () => {
    const log = [
      ev(1, { label: 'Kettensägenöl', unit: 'l', menge: 2 }),
      ev(2, { label: 'Kettensägenöl', unit: 'l', menge: 2, deleted: true }),
    ]
    expect(visibleMittel(log)).toHaveLength(0)
    expect(recordedMittel(log)).toHaveLength(0)
    // undo is just another event — the tombstone clears
    const undone = [...log, ev(3, { label: 'Kettensägenöl', unit: 'l', menge: 2, deleted: false })]
    expect(recordedMittel(undone)).toHaveLength(1)
    expect(visibleMittel(undone)).toHaveLength(1)
  })

  it('carries a hand-added line’s Bestand into its list row', () => {
    const rows = mittelListGroups(
      [ev(1, { label: 'Kettensägenöl', unit: 'l', menge: 2, stock: 5 })],
      [], [], { other: 'Übrige', custom: 'Weitere' },
    )
    const custom = rows.find((g) => g.custom)
    expect(custom?.rows[0]).toMatchObject({ label: 'Kettensägenöl', totalUsed: 2, totalStock: 5 })
    expect(custom?.rows[0].cells[0]).toMatchObject({ stock: 5, used: 2 })
  })

  it('shows a zeroed hand-added line in the list group', () => {
    const rows = mittelListGroups(
      [ev(1, { label: 'Absperrband', unit: 'Rolle', menge: 1 }), ev(2, { label: 'Absperrband', unit: 'Rolle', menge: 0 })],
      [], [], { other: 'Übrige', custom: 'Weitere' },
    )
    expect(rows.find((g) => g.custom)?.rows.map((r) => r.label)).toEqual(['Absperrband'])
  })
})

// «Stk» and «Stk.» are one unit. They keyed as two, so the same material recorded before and
// after the catalogue gained its dot printed as two lines that add up to neither figure.
describe('one unit, two spellings', () => {
  const at = (n: number) => `2026-08-10T1${n}:00:00Z`
  const e = (unit: string, menge: number, i: number): MittelEntry => ({
    id: `m${i}`, materialId: 'schlauch-b', label: 'Schlauch 75er', unit,
    sourceId: 'tlf', sourceLabel: 'TLF', menge, at: at(i), by: 'FU',
  })

  it('folds a dotless spelling into the dotted one instead of splitting the line', () => {
    const out = visibleMittel([e('Stk', 1, 1), e('Stk.', 5, 2)])
    expect(out).toHaveLength(1)
    expect(out[0].menge).toBe(5)
  })

  it('shows the fuller spelling even when the dotless entry came last', () => {
    const out = visibleMittel([e('Stk.', 5, 1), e('Stk', 1, 2)])
    expect(out).toHaveLength(1)
    expect(out[0].unit).toBe('Stk.')
    expect(out[0].menge).toBe(1) // the later event still wins on the AMOUNT
  })

  it('keeps genuinely different units apart', () => {
    const out = visibleMittel([e('Stk.', 5, 1), { ...e('l', 40, 2), materialId: 'schlauch-b' }])
    expect(out).toHaveLength(2)
  })
})

// ⚠️ One symbol is routinely SEVERAL materials. A station carries Lüfter, Hochleistungslüfter and
// Exhauster and has exactly one «VKF Luefter mobil» to place — so matching on the symbol name
// alone could only ever offer the first of the three, and an Exhauster was never findable.
describe('materialForSymbol — one symbol, several materials', () => {
  const cat: DeploymentMittelItem[] = [
    { id: 'luefter', label: 'Lüfter', unit: 'Stk.', symbol: 'VKF Luefter mobil', stock: [{ source: 'tlf', qty: 2 }] },
    { id: 'gross', label: 'Hochleistungslüfter', unit: 'Stk.', symbol: 'VKF Luefter mobil', when: { Typ: 'Grosslüfter' } },
    { id: 'exhauster', label: 'Exhauster', unit: 'Stk.', symbol: 'VKF Luefter mobil', when: { Typ: 'Exhauster' }, stock: [{ source: 'pio', qty: 1 }] },
    { id: 'saugend', label: 'Exhauster (saugend)', unit: 'Stk.', symbol: 'VKF Luefter mobil', when: { Luftrichtung: 'saugen' } },
    { id: 'tauchpumpe', label: 'Tauchpumpe', unit: 'Stk.' },
  ]

  it('picks the variant the symbol\'s own field names', () => {
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', fields: { Typ: 'Exhauster' } })?.id).toBe('exhauster')
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', fields: { Typ: 'Grosslüfter' } })?.id).toBe('gross')
  })

  it('falls back to the general material when no variant matches', () => {
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', fields: { Typ: 'Elektro' } })?.id).toBe('luefter')
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil' })?.id).toBe('luefter')
  })

  it('reads the airflow flag as a field — a Lüfter set to saugen IS an Exhauster', () => {
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', extract: true })?.id).toBe('saugend')
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', extract: false })?.id).toBe('luefter')
  })

  it('matches field names and values the way people actually type them', () => {
    expect(materialForSymbol(cat, { symbol: 'VKF Luefter mobil', fields: { typ: ' exhauster ' } })?.id).toBe('exhauster')
  })

  it('keeps the loose token match for the 1:1 cases nobody configures', () => {
    expect(materialForSymbol(cat, 'FW Tauchpumpe')?.id).toBe('tauchpumpe')
    // …and still refuses the near-miss the token rule exists to refuse
    expect(materialForSymbol([{ id: 'l', label: 'Leiter', unit: 'Stk.' }], 'VKF Einsatzleiter')).toBeUndefined()
  })

  it('takes a LIST of clauses as an OR — a Lüfter set to saugen IS an Exhauster', () => {
    // «Typ = Exhauster ODER Luftrichtung = saugen»: an AND-only schema could express neither
    // half without losing the other, and the airflow one is the case nobody remembers to type.
    const orCat: DeploymentMittelItem[] = [
      { id: 'luefter', label: 'Lüfter', unit: 'Stk.', symbol: 'VKF Luefter mobil' },
      { id: 'exhauster', label: 'Exhauster', unit: 'Stk.', symbol: 'VKF Luefter mobil',
        when: [{ Typ: 'Exhauster' }, { Luftrichtung: 'saugen' }] },
    ]
    expect(materialForSymbol(orCat, { symbol: 'VKF Luefter mobil', fields: { Typ: 'Exhauster' } })?.id).toBe('exhauster')
    expect(materialForSymbol(orCat, { symbol: 'VKF Luefter mobil', extract: true })?.id).toBe('exhauster')
    // …and neither of them true still falls through to the general material
    expect(materialForSymbol(orCat, { symbol: 'VKF Luefter mobil', fields: { Typ: 'Elektro' } })?.id).toBe('luefter')
  })

  it('treats a clause as an AND over its own fields', () => {
    const andCat: DeploymentMittelItem[] = [
      { id: 'both', label: 'Beides', unit: 'Stk.', symbol: 'S', when: { Typ: 'A', Ort: 'B' } },
    ]
    expect(materialForSymbol(andCat, { symbol: 'S', fields: { Typ: 'A', Ort: 'B' } })?.id).toBe('both')
    expect(materialForSymbol(andCat, { symbol: 'S', fields: { Typ: 'A' } })).toBeUndefined()
  })

  it('never lets an empty clause match everything — that is a config mistake, not a wildcard', () => {
    const bad: DeploymentMittelItem[] = [{ id: 'x', label: 'X', unit: 'Stk.', symbol: 'S', when: {} }]
    expect(materialForSymbol(bad, { symbol: 'S' })).toBeUndefined()
  })

  it('books from where the Bestand says it lives', () => {
    expect(defaultSourceFor(cat[2])).toBe('pio')
    expect(defaultSourceFor(cat[0])).toBe('tlf')
    expect(defaultSourceFor(cat[1])).toBeUndefined()
  })

  it('is silent on a station that mapped nothing — no offers nobody asked for', () => {
    expect(symbolCaptureConfigured([{ id: 'x', label: 'Lüfter', unit: 'Stk.' }])).toBe(false)
    expect(symbolCaptureConfigured(cat)).toBe(true)
  })
})
