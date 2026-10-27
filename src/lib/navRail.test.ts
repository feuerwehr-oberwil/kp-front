import { describe, it, expect } from 'vitest'
import { clampRailWidth, snapExpanded, planGlyph, moduleNumbers, planLabel, foldPlanTiles, navStops } from './navRail'
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
  it('maps the blank Tafel → its easel icon', () => expect(planGlyph(doc({ id: 'tafel', icon: 'easel' }))).toEqual({ icon: 'easel' }))
  it('defaults the Tafel glyph to the easel when no icon is set', () => expect(planGlyph(doc({ id: 'tafel' }))).toEqual({ icon: 'easel' }))
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

// owner, 27.10.2026: «spelled out as Wasser, and then with 1 or 2 if there are multiple … the
// same way as for photovoltaic, where it's just PV» — one name per plan, from its module key
describe('planLabel — the one name a plan goes by', () => {
  it.each([
    ['modul1', 'Modul 1'],
    ['modul4', 'Modul 4'],
    ['modul2-3', 'Modul 2/3'],
    ['modul5', 'Modul 5'],
    ['modul5-pv', 'PV'],
    ['modul5-rwa', 'RWA'],
    ['modul5-wasser', 'Wasser'],
    ['modul5-wasser1', 'Wasser 1'],
    ['modul5-wasser2', 'Wasser 2'],
    ['modul5-pv15', 'PV 15'],
    [' Modul5-Wasser ', 'Wasser'],
  ])('%s → %s', (id, label) => expect(planLabel(id)).toBe(label))

  it('a key that is no module key says the caller\'s word, else the id', () => {
    expect(planLabel('tafel', 'Tafel')).toBe('Tafel')
    expect(planLabel('gebaeude')).toBe('gebaeude')
  })
})

describe('the label and the chip agree', () => {
  it('an abbreviation is the chip, a numbered sibling keeps its number', () => {
    expect(planGlyph(doc({ id: 'modul5-pv' }))).toEqual({ mono: 'PV' })
    expect(planGlyph(doc({ id: 'modul5-rwa' }))).toEqual({ mono: 'RWA' })
    expect(planGlyph(doc({ id: 'modul5-pv15' }))).toEqual({ mono: 'PV15' })
  })
  // «WAS» named nothing, and «Wasser» does not fit a round chip: the plan icon, the word in the label
  it('a word wears the plan icon, never its first letters', () => {
    expect(planGlyph(doc({ id: 'modul5-wasser', code: 'W' }))).toEqual({ icon: 'doc' })
    expect(planGlyph(doc({ id: 'modul5-wasser2' }))).toEqual({ icon: 'doc' })
  })
})

// The phone bar folds every plan document into ONE tile (18.09.2026) — so the fold has to hand
// back the document that is loaded (it IS the tile's glyph), and it has to say whether a chooser
// exists at all. It carries NO sub-label any more: one glyph and one word, like every tile
// beside it.
describe('foldPlanTiles', () => {
  const docs = [
    doc({ id: 'modul1', code: 'M1' }),
    doc({ id: 'gebaeude', code: 'Gebäude', floorStack: true }),
    doc({ id: 'tafel', code: 'Tafel' }),
  ]

  it('is nothing at all without a plan document — the rail keeps its empty state', () =>
    expect(foldPlanTiles([], 'modul1')).toBeNull())

  it('hands back the active document — the tile wears its glyph', () =>
    expect(foldPlanTiles(docs, 'gebaeude')).toMatchObject({ target: docs[1], many: true }))

  // the tile shows ONE word, «Pläne». The document's code is the aria-label's job, not a third
  // line of type in a 46px tile (field report 18.09.2026).
  it('carries no sub-label at all', () =>
    expect(foldPlanTiles(docs, 'gebaeude')).not.toHaveProperty('sub'))

  it('opens the active document on a first tap', () =>
    expect(foldPlanTiles(docs, 'tafel')?.target.id).toBe('tafel'))

  // switching Einsatzobjekt leaves an id behind that no document answers to
  it('falls back to the first document when the active id does not resolve', () =>
    expect(foldPlanTiles(docs, 'modul9')?.target.id).toBe('modul1'))

  it('offers no chooser for a single document', () =>
    expect(foldPlanTiles([docs[0]], 'modul1')).toEqual({ target: docs[0], many: false }))
})

/* ⌘[ / ⌘] steps what the rail SHOWS — every tile is a stop, and nothing else is. */
describe('navStops', () => {
  const modes = (fold: boolean) => navStops(['modul1', 'gebaeude'], fold).map((n) => n.mode)

  it('walks the rail top to bottom, one stop per plan document', () =>
    expect(navStops(['modul1', 'gebaeude'], false)).toEqual([
      { mode: 'map' },
      { mode: 'plans', planId: 'modul1' },
      { mode: 'plans', planId: 'gebaeude' },
      { mode: 'checklists' },
      { mode: 'atemschutz' },
      { mode: 'anwesenheit' },
      { mode: 'mittel' },
      { mode: 'rapport' },
    ]))

  // ⚠️ every surface stays steppable on a phone too — Anwesenheit and Material are ordinary
  // separate pages there, reached through the Rapport tile and the chooser behind it
  it('stops on all three of the Rapport group, folded or not', () => {
    for (const fold of [false, true]) {
      expect(modes(fold)).toContain('rapport')
      expect(modes(fold)).toContain('anwesenheit')
      expect(modes(fold)).toContain('mittel')
    }
  })

  // …but in the order the fifth TILE implies: on the phone bar the Rapport is the door to the
  // group, so the step walks into it first and then through the two pages behind it
  it('leads the group with the Rapport while the phone bar is folded', () =>
    expect(modes(true)).toEqual([
      'map', 'plans', 'plans', 'checklists', 'atemschutz', 'rapport', 'anwesenheit', 'mittel',
    ]))

  it('is the bare sections on a station with no plan documents', () =>
    expect(navStops([], true)).toEqual([
      { mode: 'map' }, { mode: 'checklists' }, { mode: 'atemschutz' },
      { mode: 'rapport' }, { mode: 'anwesenheit' }, { mode: 'mittel' },
    ]))
})
