import { describe, expect, it } from 'vitest'
import { boxLines, formForPdf, newFormPage, putLine, putRow, slotted, tableSlots, type BoardFormData, type FormRow } from './boardForm'
import { mergeFormData } from './boardFormMerge'
import { BUNDLED_TEMPLATES } from './boardTemplates'
import type { TableSection } from './boardTemplate'

// Owner, staging round 2: «Test 1» typed into Mittel's 8th ruling jumped up to the 4th. A row
// stays on the ruling it was written on, like on paper — on screen, through a merge, in print.

const FKS = BUNDLED_TEMPLATES[0]
const EF = FKS.pages.find((p) => p.id === 'ef')!
const MITTEL = EF.sections.find((s) => s.id === 'mittel') as TableSection
const three = () => newFormPage(FKS, EF, { vehicles: ['TLF', 'ADF', 'MTF'] }, '2026-10-10T09:24:00.000Z')
const formations = (d: BoardFormData) => tableSlots(d, MITTEL).map((r) => r?.cells.formation ?? '')
const WORDS = { up: '+', same: '=', down: '-' }

describe('a row stays on the ruling it was written on', () => {
  it('written on the 8th ruling under three filled rows, it stays the 8th — the 4th to 7th stay empty above it', () => {
    const d = putRow(three(), 'mittel', 'x8', { cells: { formation: 'Test 1' }, slot: 7 })
    expect(formations(d)).toEqual(['TLF', 'ADF', 'MTF', '', '', '', '', 'Test 1'])
    // …and on paper: the four empty rulings print empty, «Test 1» on the 8th
    const pdf = formForPdf(d, WORDS) as { sections: { id: string; rows?: { cells: string[] }[] }[] }
    expect(pdf.sections.find((s) => s.id === 'mittel')!.rows!.map((r) => r.cells[0])).toEqual(['TLF', 'ADF', 'MTF', '', '', '', '', 'Test 1'])
  })
  it('a row emptied above others leaves its ruling empty; nothing below moves up — only the empties at the end are free', () => {
    const d = putRow(three(), 'mittel', 'x8', { cells: { formation: 'Test 1' }, slot: 7 })
    const adf = tableSlots(d, MITTEL)[1]!.id
    const e = putRow(d, 'mittel', adf, { cells: { formation: '' } })
    expect(formations(e)).toEqual(['TLF', '', 'MTF', '', '', '', '', 'Test 1'])
    const gone = putRow(e, 'mittel', 'x8', { cells: { formation: '' } })
    expect(formations(gone)).toEqual(['TLF', '', 'MTF'])
  })
  it('a new row without a ruling (the trailing row) goes right after the last written one', () => {
    const d = putRow(putRow(three(), 'mittel', 'x8', { cells: { formation: 'Test 1' }, slot: 7 }), 'mittel', 'n', { cells: { formation: 'TLF 2' } })
    expect(formations(d).slice(7)).toEqual(['Test 1', 'TLF 2'])
  })
  it('rows from before slots keep their order, and are pinned on the first write so a removal moves nothing', () => {
    const legacy = three()
    legacy.values.mittel.rows = legacy.values.mittel.rows!.map(({ slot: _s, ...r }) => r as FormRow)
    expect(formations(legacy)).toEqual(['TLF', 'ADF', 'MTF'])
    const adf = legacy.values.mittel.rows![1].id
    expect(formations(putRow(legacy, 'mittel', adf, { cells: { formation: '' } }))).toEqual(['TLF', '', 'MTF'])
  })
  it('a Problemerfassung line too: written on the 4th line, emptied in the middle — the rest stays put', () => {
    let d = three()
    d = putLine(d, 'problem', 'front', 'a', { text: 'Rauch' })
    d = putLine(d, 'problem', 'front', 'b', { text: 'Rettung' })
    d = putLine(d, 'problem', 'front', 'd', { text: 'Dach', slot: 3 })
    expect(boxLines(d, 'problem', 'front').map((l) => l?.text ?? '')).toEqual(['Rauch', 'Rettung', '', 'Dach'])
    d = putLine(d, 'problem', 'front', 'a', { text: '' })
    expect(boxLines(d, 'problem', 'front').map((l) => l?.text ?? '')).toEqual(['', 'Rettung', '', 'Dach'])
  })
})

describe('two devices, two rulings: both rows keep theirs through the merge', () => {
  it('different rulings: each where it was written', () => {
    const base = three()
    const mine = putRow(base, 'mittel', 'm', { cells: { formation: 'Test 1' }, slot: 7 }, 1000)
    const theirs = putRow(base, 'mittel', 't', { cells: { formation: 'Pio' }, slot: 4 }, 1100)
    expect(formations(mergeFormData(base, mine, theirs))).toEqual(['TLF', 'ADF', 'MTF', '', 'Pio', '', '', 'Test 1'])
    expect(formations(mergeFormData(base, theirs, mine))).toEqual(['TLF', 'ADF', 'MTF', '', 'Pio', '', '', 'Test 1'])
  })
  it('the same ruling at once: both kept, one on the next ruling — nothing written is lost', () => {
    const base = three()
    const mine = putRow(base, 'mittel', 'm', { cells: { formation: 'Test 1' }, slot: 5 }, 1000)
    const theirs = putRow(base, 'mittel', 't', { cells: { formation: 'Pio' }, slot: 5 }, 1100)
    const out = formations(mergeFormData(base, mine, theirs))
    expect(out.slice(5).sort()).toEqual(['Pio', 'Test 1'])
  })
  it('lines too', () => {
    const base = three()
    const mine = putLine(base, 'problem', 'front', 'm', { text: 'Rauch', slot: 2 }, 1000)
    const theirs = putLine(base, 'problem', 'front', 't', { text: 'Rettung', slot: 0 }, 1100)
    expect(boxLines(mergeFormData(base, mine, theirs), 'problem', 'front').map((l) => l?.text ?? '')).toEqual(['Rettung', '', 'Rauch'])
  })
})

describe('slotted', () => {
  it('lays out by slot, an item without one after the one before it, a clash on the next free ruling', () => {
    expect(slotted([{ slot: 2, n: 'a' }, { n: 'b' }, { slot: 0, n: 'c' }, { slot: 2, n: 'd' }]).map((x) => x?.n ?? '-')).toEqual(['c', '-', 'a', 'b', 'd'])
  })
})
