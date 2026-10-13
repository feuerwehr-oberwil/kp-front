import { describe, expect, it } from 'vitest'
import { applyFormDelta, boxLines, formDelta, formForPdf, moveLine, moveRow, newFormPage, putLine, putRow, writtenRows, type BoardFormData, type FormRow } from './boardForm'
import { mergeFormData } from './boardFormMerge'
import { BUNDLED_TEMPLATES } from './boardTemplates'
import type { TableSection } from './boardTemplate'

// Owner, 10.10.2026 evening: «allow for manual reordering … and then we can skip the different
// placed entry thing altogether». Entries stack from the top, no gaps, in an order the operator
// sets by hand — the same on every device, through every merge, on paper.

const FKS = BUNDLED_TEMPLATES[0]
const EF = FKS.pages.find((p) => p.id === 'ef')!
const MITTEL = EF.sections.find((s) => s.id === 'mittel') as TableSection
const three = () => newFormPage(FKS, EF, { vehicles: ['TLF', 'ADF', 'MTF'] }, '2026-10-10T09:24:00.000Z')
const formations = (d: BoardFormData) => writtenRows(d, MITTEL).map((r) => r.cells.formation ?? '')
const fronts = (d: BoardFormData) => boxLines(d, 'problem', 'front').map((l) => l.text)
const WORDS = { up: '+', same: '=', down: '-' }
const idOf = (d: BoardFormData, name: string) => writtenRows(d, MITTEL).find((r) => r.cells.formation === name)!.id

describe('entries stack from the top and keep the order they are given', () => {
  it('a new entry goes directly under the last one; an emptied one closes up', () => {
    let d = putRow(three(), 'mittel', 'n', { cells: { formation: 'Test 1' } })
    expect(formations(d)).toEqual(['TLF', 'ADF', 'MTF', 'Test 1'])
    d = putRow(d, 'mittel', idOf(d, 'ADF'), { cells: { formation: '' } })
    expect(formations(d)).toEqual(['TLF', 'MTF', 'Test 1'])
  })
  it('moving writes one key, and the order reads the same in print', () => {
    const d = three()
    const m = moveRow(d, 'mittel', idOf(d, 'MTF'), 0)
    expect(formations(m)).toEqual(['MTF', 'TLF', 'ADF'])
    expect(formDelta(d, m).map((c) => c.k)).toEqual([`r|mittel|${idOf(d, 'MTF')}|#ord`])
    const pdf = formForPdf(m, WORDS) as { sections: { id: string; rows?: { cells: string[] }[] }[] }
    expect(pdf.sections.find((s) => s.id === 'mittel')!.rows!.map((r) => r.cells[0])).toEqual(['MTF', 'TLF', 'ADF'])
    expect(moveRow(m, 'mittel', idOf(d, 'MTF'), 0)).toBe(m) // already there: no step
  })
  it('lines move in their box, and a line keeps its breaks', () => {
    let d = three()
    for (const [id, text] of [['a', 'Rauch'], ['b', 'Rettung\nHaus 19'], ['c', 'Dach']]) d = putLine(d, 'problem', 'front', id, { text })
    d = moveLine(d, 'problem', 'front', 'c', 0)
    expect(fronts(d)).toEqual(['Dach', 'Rauch', 'Rettung\nHaus 19'])
    const pdf = formForPdf(d, WORDS) as { sections: { cells?: { lines: { text: string }[] }[] }[] }
    expect(pdf.sections[0].cells![0].lines.map((l) => l.text)).toEqual(['Dach', 'Rauch', 'Rettung\nHaus 19'])
  })
  it('a page written by the builds of 10.10. (slots, with gaps) reads in that order, gaps collapsed — and keys itself on the next write', () => {
    const legacy = three()
    legacy.values.mittel.rows = [
      { id: 'x', cells: { formation: 'Test 1' }, slot: 7 },
      ...legacy.values.mittel.rows!.map(({ ord: _o, ...r }, i) => ({ ...r, slot: i }) as FormRow),
    ]
    expect(formations(legacy)).toEqual(['TLF', 'ADF', 'MTF', 'Test 1'])
    const written = putRow(legacy, 'mittel', 'n', { cells: { formation: 'Pio' } })
    expect(formations(written)).toEqual(['TLF', 'ADF', 'MTF', 'Test 1', 'Pio'])
    expect(written.values.mittel.rows!.every((r) => r.ord && r.slot === undefined)).toBe(true)
  })
})

describe('two devices', () => {
  it('reordering different entries: both moves stand, the same result either way round', () => {
    const base = three()
    const mine = moveRow(base, 'mittel', idOf(base, 'MTF'), 0, 1000) // MTF to the top
    const theirs = moveRow(base, 'mittel', idOf(base, 'TLF'), 2, 1100) // TLF to the end
    const a = formations(mergeFormData(base, mine, theirs)), b = formations(mergeFormData(base, theirs, mine))
    expect(a).toEqual(b)
    expect(a).toEqual(['MTF', 'ADF', 'TLF'])
  })
  it('the same entry moved on both: the later move stands — on every device; a tie is settled the same everywhere', () => {
    const base = three()
    const id = idOf(base, 'MTF')
    const mine = moveRow(base, 'mittel', id, 0, 1000), theirs = moveRow(base, 'mittel', id, 1, 2000)
    expect(formations(mergeFormData(base, mine, theirs))).toEqual(['TLF', 'MTF', 'ADF'])
    expect(formations(mergeFormData(base, theirs, mine))).toEqual(['TLF', 'MTF', 'ADF'])
    const tieA = moveRow(base, 'mittel', id, 0, 1500), tieB = moveRow(base, 'mittel', id, 1, 1500)
    expect(formations(mergeFormData(base, tieA, tieB))).toEqual(formations(mergeFormData(base, tieB, tieA)))
  })
  it('both append at the end at once: both kept, in one fixed order', () => {
    const base = three()
    const mine = putRow(base, 'mittel', 'fr-a', { cells: { formation: 'Pio' } }, 1000)
    const theirs = putRow(base, 'mittel', 'fr-b', { cells: { formation: 'Hub' } }, 1100)
    const a = formations(mergeFormData(base, mine, theirs)), b = formations(mergeFormData(base, theirs, mine))
    expect(a).toEqual(b)
    expect(a.slice(0, 3)).toEqual(['TLF', 'ADF', 'MTF'])
    expect([...a.slice(3)].sort()).toEqual(['Hub', 'Pio'])
  })
  it('a move on one device, an edit of the same entry on the other: both stand, no conflict row', () => {
    const base = three()
    const id = idOf(base, 'MTF')
    const seen: string[] = []
    const out = mergeFormData(base, moveRow(base, 'mittel', id, 0, 1000), putRow(base, 'mittel', id, { cells: { auftrag: 'Riegel' } }, 1100), (c) => seen.push(c.atom))
    expect(formations(out)).toEqual(['MTF', 'TLF', 'ADF'])
    expect(writtenRows(out, MITTEL)[0].cells.auftrag).toBe('Riegel')
    expect(seen).toEqual([])
  })
})

describe('the audit and the Replay', () => {
  it('a move replays from its audit delta', () => {
    const base = three()
    const moved = moveRow(base, 'mittel', idOf(base, 'MTF'), 0)
    expect(formations(applyFormDelta(base, formDelta(base, moved)))).toEqual(['MTF', 'TLF', 'ADF'])
    let d = putLine(base, 'problem', 'front', 'a', { text: 'Rauch' })
    d = putLine(d, 'problem', 'front', 'b', { text: 'Dach' })
    const m2 = moveLine(d, 'problem', 'front', 'b', 0)
    expect(fronts(applyFormDelta(d, formDelta(d, m2)))).toEqual(['Dach', 'Rauch'])
  })
})
