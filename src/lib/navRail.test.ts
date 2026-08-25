import { describe, it, expect } from 'vitest'
import { clampRailWidth, snapExpanded, planGlyph, moduleNumbers, moduleTileLabel } from './navRail'
import type { PlanDocument } from '../types'

// a minimal PlanDocument factory — only the fields planGlyph reads matter
const doc = (over: Partial<PlanDocument>): PlanDocument => ({
  id: 'x', code: '', title: '', subtitle: '', imageUrl: '', orientation: 'portrait', ...over,
})

describe('clampRailWidth', () => {
  it('clamps below the minimum', () => expect(clampRailWidth(10)).toBe(60))
  it('clamps above the maximum', () => expect(clampRailWidth(400)).toBe(216))
  it('passes an in-range value through', () => expect(clampRailWidth(120)).toBe(120))
  it('honours custom bounds', () => expect(clampRailWidth(5, 40, 100)).toBe(40))
})

describe('snapExpanded', () => {
  it('stays collapsed below the snap point', () => expect(snapExpanded(100)).toBe(false))
  it('expands above the snap point', () => expect(snapExpanded(180)).toBe(true))
  it('is false exactly at the boundary', () => expect(snapExpanded(138)).toBe(false))
})

describe('planGlyph', () => {
  it('maps modul1 → bare 1 monogram (no M prefix)', () => expect(planGlyph(doc({ id: 'modul1' }))).toEqual({ mono: '1' }))
  it('maps modul6 → bare 6 monogram (no M prefix)', () => expect(planGlyph(doc({ id: 'modul6' }))).toEqual({ mono: '6' }))
  it('maps a combined modul2-3 → fractional 2/3 monogram', () => expect(planGlyph(doc({ id: 'modul2-3' }))).toEqual({ mono: '2/3' }))
  it('maps the floor-stack → its (layers) icon, not a bare G', () => expect(planGlyph(doc({ id: 'gebaeude', floorStack: true, icon: 'layers' }))).toEqual({ icon: 'layers' }))
  it('maps the blank Tafel → its pen icon', () => expect(planGlyph(doc({ id: 'tafel', icon: 'pen' }))).toEqual({ icon: 'pen' }))
  it('defaults the Tafel glyph to pen when no icon is set', () => expect(planGlyph(doc({ id: 'tafel' }))).toEqual({ icon: 'pen' }))
  it('falls back to the doc icon for a generic plan', () => expect(planGlyph(doc({ id: 'osm', icon: 'map' }))).toEqual({ icon: 'map' }))
  it('falls back to the doc icon when none is set', () => expect(planGlyph(doc({ id: 'other' }))).toEqual({ icon: 'doc' }))
})

describe('moduleNumbers — the digit(s) a plan doc answers to', () => {
  it('a single module answers its own number', () => expect(moduleNumbers(doc({ id: 'modul4' }))).toEqual([4]))
  it('a combined sheet answers BOTH digits', () => expect(moduleNumbers(doc({ id: 'modul2-3' }))).toEqual([2, 3]))
  it('a sub-slot (PV) carries no number', () => expect(moduleNumbers(doc({ id: 'modul5-pv', code: 'PV' }))).toEqual([]))
  // the 2 in «Wasser 2» is the second waterplan, NOT Modul 2 — pressing 2 must not open it
  it('a NUMBERED sub-slot still carries no number', () =>
    expect(moduleNumbers(doc({ id: 'modul5-wasser2', code: 'Wasser 2' }))).toEqual([]))
  it('the Umgebung / a generic plan carries no number', () => expect(moduleNumbers(doc({ id: 'osm', icon: 'map' }))).toEqual([]))
  it('the Gebäude floor-stack carries no number', () => expect(moduleNumbers(doc({ id: 'gebaeude', floorStack: true }))).toEqual([]))
})

describe('moduleTileLabel — the rail is 216px wide, the label has to fit', () => {
  it('takes a sub-sheet name the station actually gave us', () =>
    expect(moduleTileLabel('modul5-wasser', 'Wasser')).toBe('Wasser'))

  // The live Oberwil files are named after the object plus the raw module key. Using that as
  // the label ran the rail item straight off its edge ("Migros – modul5-rwa…").
  it('refuses a filename that only echoes the module key back', () =>
    expect(moduleTileLabel('modul5-rwa', 'Migros – modul5-rwa')).toBe('RWA'))

  it('refuses any long title, however descriptive', () =>
    expect(moduleTileLabel('modul5-pv', 'Photovoltaik-Anlage Dach Nord')).toBe('PV'))

  it('keeps an acronym upper-case', () => expect(moduleTileLabel('modul5-rwa')).toBe('RWA'))
  it('capitalises a word instead of shouting it', () => expect(moduleTileLabel('modul5-wasser')).toBe('Wasser'))
  it('is unfazed by an empty or missing title', () => {
    expect(moduleTileLabel('modul5-pv', '')).toBe('PV')
    expect(moduleTileLabel('modul5-pv', '   ')).toBe('PV')
  })

  it('a bare module keeps «Modul N»', () => {
    expect(moduleTileLabel('modul4')).toBe('Modul 4')
    expect(moduleTileLabel('modul4', 'Migros – modul4')).toBe('Modul 4')
  })

  // An object with «Modul 5 - Wasser 1» AND «… Wasser 2» has two waterplans. Two tiles reading
  // the same word would be worse than useless at 3am — the number is what tells them apart.
  it('keeps the number of a numbered sibling', () => {
    expect(moduleTileLabel('modul5-wasser1', 'Wasser 1')).toBe('Wasser 1')
    expect(moduleTileLabel('modul5-wasser2', 'Wasser 2')).toBe('Wasser 2')
  })

  it('recovers the number from the id when the title is unusable', () => {
    expect(moduleTileLabel('modul5-wasser2', 'Migros – modul5-wasser2')).toBe('Wasser 2')
    expect(moduleTileLabel('modul5-wasser3')).toBe('Wasser 3')
    expect(moduleTileLabel('modul5-pv15')).toBe('PV 15')
  })
})

describe('the label and the chip agree', () => {
  // planGlyph takes doc.code when it is short — so the fix has to leave the collapsed rail
  // showing the same monogram it always did, not just tidy the expanded one.
  it('a sub-slot shows its acronym in the chip', () =>
    expect(planGlyph(doc({ id: 'modul5-rwa', code: moduleTileLabel('modul5-rwa', 'Migros – modul5-rwa') })))
      .toEqual({ mono: 'RWA' }))
  it('a longer sub-sheet name still shortens to a monogram', () =>
    expect(planGlyph(doc({ id: 'modul5-wasser', code: moduleTileLabel('modul5-wasser') })))
      .toEqual({ mono: 'WAS' }))

  // The collapsed rail shows monograms only — so the sibling number has to reach the chip too,
  // or the two waterplans are one indistinguishable «WAS» twice.
  it('numbered siblings get distinct monograms', () => {
    const chip = (id: string, title: string) => planGlyph(doc({ id, code: moduleTileLabel(id, title) }))
    expect(chip('modul5-wasser1', 'Wasser 1')).toEqual({ mono: 'WAS1' })
    expect(chip('modul5-wasser2', 'Wasser 2')).toEqual({ mono: 'WAS2' })
    expect(chip('modul5-pv15', 'PV 15')).toEqual({ mono: 'PV15' })
    expect(chip('modul5-pv20', 'PV 20')).toEqual({ mono: 'PV20' })
  })
})
