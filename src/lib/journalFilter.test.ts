import { describe, expect, it } from 'vitest'
import { journalCategories, journalCategory, journalFacets, matchesJournalCategories, showsPinnedPendenzen } from './journalFilter'
import { filterJournal } from './journalSearch'
import type { PlanDocument, TimelineEvent } from '../types'

const at = '2026-09-23T09:00:00.000Z'
const row = (id: string, text: string, over: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, t: '09:00', at, icon: 'type', text, ...over })

const plans: PlanDocument[] = [
  { id: 'tafel', code: 'Tafel', title: 'Tafel', subtitle: '', imageUrl: '', orientation: 'landscape' },
  { id: 'm2', code: 'Modul 2', title: 'Zugang', subtitle: '', imageUrl: 'm2.pdf', orientation: 'landscape' },
  // ⚠️ a plan an author happened to call like one of the Bereiche
  { id: 'r', code: 'Rapport', title: 'Rapport', subtitle: '', imageUrl: 'r.pdf', orientation: 'portrait' },
]

// one row of every kind the Verlauf writes, the way their writers write them
const events: TimelineEvent[] = [
  row('man', 'Lage: Rauch aus dem 1. OG', { kind: 'journal' }),
  row('auf', 'Auftrag · Trupp 2 sichert den Rückzug', { kind: 'journal', entryType: 'auftrag' }),
  row('sof', 'Sofortmassnahme · Strom abgeschaltet', { kind: 'journal', entryType: 'sofort' }),
  row('pnd', 'Lüfter nachfordern', { kind: 'reminder', reminder: { op: 'created', id: 'p1', assignee: 'Müller Hans' } }),
  row('map', 'Hydrant gesetzt', { icon: 'hex', kind: 'symbol', surface: 'map' }),
  row('taf', 'Trupp 2 platziert', { icon: 'hex', kind: 'symbol', surface: 'plan', planId: 'tafel' }),
  row('m2', 'Symbol gesetzt', { icon: 'hex', kind: 'symbol', surface: 'plan', planId: 'm2' }),
  row('rpl', 'Symbol gesetzt', { icon: 'hex', kind: 'symbol', surface: 'plan', planId: 'r' }),
  row('az1', 'Trupp 2 (Fabich Mischa): Druckmeldung 180 bar', { icon: 'gauge', kind: 'team' }),
  row('az2', 'Trupp 3 (Meier Anna): Funkkontakt', { icon: 'radio', kind: 'team' }),
  row('anw', 'Anwesend: Meier Anna', { icon: 'people', kind: 'team' }),
  row('mit', 'Material: 2 Lüfter', { icon: 'box', kind: 'team' }),
  row('chk', 'Checkliste: Strom abgeschaltet', { icon: 'check', kind: 'journal' }),
  row('rap', 'Rapportangaben: Einsatzleiter Meier Anna', { icon: 'clipboard' }),
  row('sys1', 'Einsatz abgeschlossen', { id: 'sys1', icon: 'flag' }),
]
const cats = journalCategories(events, plans)
const keyOf = (id: string) => cats.get(id)!.key

describe('journalCategory · the Verlauf’s own words, no new taxonomy', () => {
  it('files every row under exactly one category, in its group', () => {
    expect(events.map((e) => journalCategory(e, plans).label)).toEqual([
      'Manuell', 'Auftrag', 'Sofortmassnahme', 'Pendenz',
      'Karte', 'Tafel', 'Modul 2', 'Rapport',
      'Trupps', 'Trupps', 'Anwesenheit', 'Material', 'Checkliste', 'Rapport', 'System',
    ])
    expect(journalCategory(events[1], plans).group).toBe('art')
    expect(journalCategory(events[3], plans).group).toBe('art')
    expect(journalCategory(events[4], plans).group).toBe('bereich')
  })

  // ⚠️ the label is not the key: a plan named «Rapport» is a PLAN, told by the disc's tint
  it('keeps a plan that is named like a Bereich apart from that Bereich', () => {
    expect(keyOf('rpl')).toBe('plan:Rapport')
    expect(keyOf('rap')).toBe('rapport')
    expect(keyOf('rpl')).not.toBe(keyOf('rap'))
  })

  it('a Pendenz raised as an Auftrag is an Auftrag — journalArea’s own precedence', () => {
    const e = row('x', 'Auftrag · Leiter stellen', { kind: 'journal', entryType: 'auftrag', reminder: { op: 'created', id: 'p9' } })
    expect(journalCategory(e, plans).kind).toBe('auftrag')
  })
})

describe('journalFacets · the menu’s rows and counts', () => {
  it('lists every category once, Art first, then the legend’s order, plans by name', () => {
    const f = journalFacets(events, events, cats)
    expect(f.map((x) => x.label)).toEqual([
      'Manuell', 'Auftrag', 'Sofortmassnahme', 'Pendenz',
      'Karte', 'Modul 2', 'Rapport', 'Tafel',
      'Anwesenheit', 'Trupps', 'Material', 'Rapport', 'Checkliste', 'System',
    ])
    expect(f.find((x) => x.key === 'atemschutz')?.count).toBe(2)
    expect(f.reduce((n, x) => n + x.count, 0)).toBe(events.length)
  })

  // the rows come from the whole Verlauf so the menu holds still while typing; the counts come
  // from what the search kept
  it('counts over the searched rows, keeping emptied categories at 0', () => {
    const searched = filterJournal(events, 'trupp 2')
    expect(searched.map((e) => e.id)).toEqual(['auf', 'taf', 'az1'])
    const f = journalFacets(events, searched, cats)
    expect(f).toHaveLength(14)
    expect(Object.fromEntries(f.filter((x) => x.count).map((x) => [x.key, x.count])))
      .toEqual({ auftrag: 1, 'plan:Tafel': 1, atemschutz: 1 })
    expect(f.find((x) => x.key === 'manual')?.count).toBe(0)
  })

  it('keeps a ticked category whose rows are gone, so it can be unticked', () => {
    const f = journalFacets(events, events, cats, new Set(['plan:Modul 9', 'auftrag']))
    const gone = f.find((x) => x.key === 'plan:Modul 9')
    expect(gone).toMatchObject({ kind: 'plan', label: 'Modul 9', group: 'bereich', count: 0 })
    expect(f.filter((x) => x.key === 'auftrag')).toHaveLength(1)
  })

  it('an empty Verlauf has no categories', () => {
    expect(journalFacets([], [], new Map())).toEqual([])
  })
})

describe('filterJournal · ticks × search', () => {
  const ids = (raw: string, ...keys: string[]) =>
    filterJournal(events, raw, { selected: new Set(keys), plans }).map((e) => e.id)

  it('nothing ticked keeps everything, like a blank query', () => {
    expect(ids('')).toEqual(events.map((e) => e.id))
    expect(matchesJournalCategories(events[0], new Set(), cats)).toBe(true)
  })

  it('one tick keeps its rows, in order', () => {
    expect(ids('', 'atemschutz')).toEqual(['az1', 'az2'])
    expect(ids('', 'plan:Tafel')).toEqual(['taf'])
  })

  // every row is in ONE category, so «Auftrag» AND «Trupps» would always be empty — the ticks
  // are one facet, across both groups of the menu
  it('ticks OR together, across the two groups', () => {
    expect(ids('', 'auftrag', 'sofort', 'pendenz')).toEqual(['auf', 'sof', 'pnd'])
    expect(ids('', 'auftrag', 'atemschutz')).toEqual(['auf', 'az1', 'az2'])
  })

  it('ticks AND with the search', () => {
    expect(ids('trupp 2', 'atemschutz')).toEqual(['az1'])
    expect(ids('trupp 2', 'auftrag', 'plan:Tafel')).toEqual(['auf', 'taf'])
    expect(ids('mueller', 'pendenz')).toEqual(['pnd']) // the Pendenz's «Wer» is searched too
    expect(ids('mueller', 'auftrag')).toEqual([])
    expect(ids('druckmeldung', 'manual')).toEqual([])
  })

  it('a search alone is unchanged by the new parameter', () => {
    expect(ids('strom')).toEqual(filterJournal(events, 'strom').map((e) => e.id))
    expect(ids('strom')).toEqual(['sof', 'chk'])
  })
})

// The user's decision (24.09.2026): the pinned Pendenzen block is part of what the ticks narrow.
describe('showsPinnedPendenzen', () => {
  it('shows the block unfiltered, and whenever «Pendenz» is among the ticks', () => {
    expect(showsPinnedPendenzen(new Set())).toBe(true)
    expect(showsPinnedPendenzen(new Set([keyOf('pnd')]))).toBe(true)
    expect(showsPinnedPendenzen(new Set([keyOf('auf'), keyOf('pnd')]))).toBe(true)
  })

  it('hides it under any filter that leaves «Pendenz» unticked', () => {
    expect(showsPinnedPendenzen(new Set([keyOf('auf')]))).toBe(false)
    expect(showsPinnedPendenzen(new Set([keyOf('az1'), keyOf('taf')]))).toBe(false)
  })
})
