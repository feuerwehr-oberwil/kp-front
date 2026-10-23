import { describe, expect, it } from 'vitest'
import {
  chapterOf,
  checklistAssetUrl,
  deviceCover,
  manualGroups,
  readingPoints,
  searchLibrary,
  snippet,
  isChecklistTemplateId,
  matchEntries,
  phaseItems,
  phaseProgress,
  searchEntries,
  templateProgress,
  type ChecklistTemplate,
  type Phase,
  type RefEntry,
  type TemplateState,
} from './checklists'

const phaseWithBranch: Phase = {
  id: 'p1',
  title: 'Zweiteintreffend',
  items: [{ id: 'base', text: 'Immer' }],
  branches: [
    { id: 'ohne', title: 'ohne C-FU', items: [{ id: 'a', text: 'A' }] },
    { id: 'mit', title: 'mit C-FU', items: [{ id: 'b', text: 'B' }, { id: 'c', text: 'C' }] },
  ],
}

describe('isChecklistTemplateId', () => {
  it('accepts a template id (checklists:<slug>)', () => {
    expect(isChecklistTemplateId('checklists:fu-aktion')).toBe(true)
    expect(isChecklistTemplateId('checklists:el-playbook')).toBe(true)
  })
  it('rejects a diagram asset id (checklists:<slug>:p<N>) and non-checklist ids', () => {
    expect(isChecklistTemplateId('checklists:el-playbook:p12')).toBe(false)
    expect(isChecklistTemplateId('geo:hydrant')).toBe(false)
    expect(isChecklistTemplateId('symbols:tactical')).toBe(false)
    expect(isChecklistTemplateId('plan:abc:modul1')).toBe(false)
  })
})

describe('checklistAssetUrl', () => {
  it('builds the registry URL for a template diagram page', () => {
    expect(checklistAssetUrl({ id: 'el-playbook' }, 12)).toBe('/api/reference/checklists:el-playbook:p12')
  })

  it('names the asset version the template was stamped with – a fixed address', () => {
    expect(checklistAssetUrl({ id: 'el-playbook', assetVersions: { 12: 3 } }, 12)).toBe('/api/reference/checklists:el-playbook:p12?v=3')
  })
})

describe('phaseItems', () => {
  it('returns only base items when no branch is chosen', () => {
    expect(phaseItems(phaseWithBranch).map((i) => i.id)).toEqual(['base'])
  })
  it('includes the selected branch items', () => {
    expect(phaseItems(phaseWithBranch, 'mit').map((i) => i.id)).toEqual(['base', 'b', 'c'])
  })
  it('returns plain items for a branchless phase', () => {
    const p: Phase = { id: 'x', title: 'X', items: [{ id: '1', text: '1' }] }
    expect(phaseItems(p)).toHaveLength(1)
  })
})

describe('progress', () => {
  const state: TemplateState = { ticks: { base: { t: 'now' }, b: { t: 'now' } }, activeBranch: { p1: 'mit' } }
  it('counts ticks of live items only (honours branch)', () => {
    const pr = phaseProgress(phaseWithBranch, state)
    expect(pr).toEqual({ done: 2, total: 3, pct: 67 })
  })
  it('rolls up across phases', () => {
    const t: ChecklistTemplate = { id: 't', kind: 'action', title: 'T', version: 1, source: 's', phases: [phaseWithBranch] }
    expect(templateProgress(t, state).total).toBe(3)
  })
  it('handles an empty/untouched template state', () => {
    const t: ChecklistTemplate = { id: 't', kind: 'action', title: 'T', version: 1, source: 's', phases: [phaseWithBranch] }
    expect(templateProgress(t, { ticks: {} })).toEqual({ done: 0, total: 1, pct: 0 })
  })
})

const entries: RefEntry[] = [
  { id: 'tg', title: 'Tiefgaragenbrand', keywords: ['parking', 'einstellhalle'], diveraKeywords: ['tiefgarage', 'einstellhalle'], hazardColor: 'red', content: [] },
  { id: 'wespen', title: 'Wespen / Hornissen', keywords: ['wespe', 'biene'], diveraKeywords: ['wespen', 'insekten'], hazardColor: 'yellow', content: [] },
]

describe('searchEntries', () => {
  it('returns all on empty query', () => {
    expect(searchEntries(entries, '  ')).toHaveLength(2)
  })
  it('matches title and keywords case-insensitively', () => {
    expect(searchEntries(entries, 'WESPE').map((e) => e.id)).toEqual(['wespen'])
    expect(searchEntries(entries, 'einstell').map((e) => e.id)).toEqual(['tg'])
  })
})

describe('matchEntries', () => {
  /** one reference template with these entries, in this (the station's) order */
  const taktik = (...es: [id: string, diveraKeywords: string[]][]): ChecklistTemplate[] => [{
    id: 'el', kind: 'reference', title: 'EL', version: 1, source: 's',
    entries: es.map(([id, diveraKeywords]) => ({ id, title: id, keywords: [], diveraKeywords, content: [] })),
  }]
  const ids = (es: RefEntry[]) => es.map((e) => e.id)
  const station = taktik(
    ['brand', ['BRAND', 'FEUER', 'ZIMMERBRAND']],
    ['tg', ['TIEFGARAGE', 'GARAGE', 'BRAND']],
    ['gas', ['GAS', 'GASLEITUNG']],
    ['bauernhof', ['BAUERNHOF', 'STALL', 'BRAND']],
  )

  it('matches a keyword in the title', () => {
    expect(ids(matchEntries(station, 'Zimmerbrand Schloss'))).toEqual(['brand'])
  })
  it('gives none for a title without a keyword – a keyword inside another word is none', () => {
    expect(matchEntries(station, 'Wasserschaden Schlossgasse 9')).toEqual([])
    expect(matchEntries(station, 'Kellerbrand')).toEqual([])
  })
  it('matches a keyword of several words as a phrase', () => {
    const t = taktik(['ea', ['PKW BRAND', 'E-AUTO']])
    expect(ids(matchEntries(t, 'PKW Brand A2'))).toEqual(['ea'])
    expect(ids(matchEntries(t, 'E-Auto Garage'))).toEqual(['ea'])
    expect(matchEntries(t, 'Brand PKW')).toEqual([])
  })
  it('leads with the most specific: the longest keyword, then the most keywords hit', () => {
    expect(ids(matchEntries(station, 'Brand Tiefgarage Schloss'))).toEqual(['tg', 'brand', 'bauernhof'])
    expect(ids(matchEntries(station, 'Brand im Stall'))).toEqual(['bauernhof', 'brand', 'tg'])
  })
  it('breaks a tie in the station order, not alphabetically', () => {
    const t = taktik(['wohnung', ['BRAND']], ['bauernhof', ['BRAND']], ['auto', ['BRAND']])
    expect(ids(matchEntries(t, 'Brand'))).toEqual(['wohnung', 'bauernhof', 'auto'])
  })

  // The reported case: one Stichwort, three answers, none of them derivable from the alarm text.
  it('offers every page a «VU Strasse» could turn out to need', () => {
    const t = taktik(['vu', ['VU']], ['ea', ['VU STRASSE']], ['oel', ['STRASSE']], ['wesp', ['WESPEN']])
    expect(ids(matchEntries(t, 'VU Strasse Hauptstrasse 12'))).toEqual(['ea', 'oel', 'vu'])
  })

  it('caps how many it offers, so a broad keyword does not become a second list', () => {
    const many = taktik(...Array.from({ length: 9 }, (_, i): [string, string[]] => [`e${i}`, ['brand']]))
    expect(matchEntries(many, 'Brand')).toHaveLength(4)
    expect(matchEntries(many, 'Brand', 2)).toHaveLength(2)
  })
})

// --- devices and the library search (19.10.2026) ---------------------------------------------

const manual = (id: string, device: string, extra: Partial<ChecklistTemplate> = {}): ChecklistTemplate =>
  ({ id, kind: 'manual', title: id, device, version: 1, source: 'x', steps: [{ text: `${id} Schritt` }], ...extra })

describe('deviceCover', () => {
  it('is the first step picture over the chapters in order, or null', () => {
    const plain = manual('a', 'D')
    const pictured = manual('b', 'D', { steps: [{ text: 's' }, { text: 't', images: [{ page: 4 }, { page: 5 }] }] })
    expect(deviceCover({ device: 'D', manuals: [plain, pictured] })).toBe('/api/reference/checklists:b:p4')
    expect(deviceCover({ device: 'D', manuals: [plain] })).toBeNull()
  })

  it('prefers the first chapter that names a cover, even over an earlier step picture', () => {
    const pictured = manual('a', 'D', { steps: [{ text: 's', images: [{ page: 1 }] }] })
    const covered = manual('b', 'D', { cover: 9, assetVersions: { 9: 2 } })
    expect(deviceCover({ device: 'D', manuals: [pictured, covered] })).toBe('/api/reference/checklists:b:p9?v=2')
  })
})

describe('chapterOf', () => {
  const groups = manualGroups([manual('k1', 'MS'), manual('k2', 'MS'), manual('k3', 'MS'), manual('solo', 'Gen')], '')
  it('says «k von n» and names the neighbours', () => {
    const c = chapterOf(groups, 'k2')!
    expect([c.k, c.n, c.prev?.id, c.next?.id]).toEqual([2, 3, 'k1', 'k3'])
    expect(chapterOf(groups, 'k1')!.prev).toBeNull()
  })
  it('gives a device with one Anleitung no chapters', () => {
    expect(chapterOf(groups, 'solo')).toBeNull()
  })
})

describe('readingPoints', () => {
  it('counts each phase with its first variant, or the picked one', () => {
    const t: ChecklistTemplate = { id: 't', kind: 'action', title: 'T', version: 1, source: 'x', phases: [phaseWithBranch] }
    expect(readingPoints(t)).toBe(2)
    expect(readingPoints(t, { p1: 'mit' })).toBe(3)
  })
})

describe('searchLibrary', () => {
  const gen = manual('gen', 'Generator', { title: 'Strom-Einspeisung', keywords: ['Notstrom'], steps: [{ text: 'Hauptschalter auf 0' }] })
  const xam = manual('xam', 'Multiwarn', { title: 'Begasungstest', steps: [{ text: 'Volumenstrom 0,5 L/min' }] })
  const fk: ChecklistTemplate = { id: 'fk', kind: 'action', title: 'Führungskreis', version: 1, source: 'x',
    phases: [{ id: 'p', title: 'P', items: [{ id: 'i', text: 'Elektrizität / Strom abstellen' }] }] }
  const taktik: ChecklistTemplate = { id: 'tk', kind: 'reference', title: 'Taktik', version: 1, source: 'x', entries: [
    { id: 'pv', title: 'Photovoltaik', keywords: ['Gleichstrom'], content: [] },
    { id: 'gas', title: 'Gasleitung', keywords: [], content: [{ type: 'bullet', text: 'Gebäude stromlos machen' }] },
    { id: 'ws', title: 'Wasserschaden', keywords: [], content: [] },
  ] }
  const all = [gen, xam, fk, taktik]

  it('finds every kind, and says why when the name does not', () => {
    const hits = searchLibrary(all, 'strom')
    expect(hits.manuals.map((h) => [h.item.id, h.why])).toEqual([['gen', null], ['xam', { text: 'Volumenstrom 0,5 L/min' }]])
    expect(hits.checklists.map((h) => h.why)).toEqual([{ text: 'Elektrizität / Strom abstellen' }])
    expect(hits.references[0].entries.map((h) => [h.item.id, h.why])).toEqual([['pv', { keyword: 'Gleichstrom' }], ['gas', { text: 'Gebäude stromlos machen' }]])
  })
  it('finds an Anleitung by its device name', () => {
    expect(searchLibrary(all, 'multiwarn').manuals.map((h) => h.item.id)).toEqual(['xam'])
  })
  it('finds nothing for an empty query (the surface shows its home)', () => {
    expect(searchLibrary(all, '  ')).toEqual({ manuals: [], checklists: [], references: [] })
  })
})

describe('snippet', () => {
  it('keeps a short line whole and cuts a long one at word edges around the match', () => {
    expect(snippet('Gebäude stromlos machen', 'strom')).toBe('Gebäude stromlos machen')
    const src = 'Beim Begasungstest ist darauf zu achten, dass dabei der Volumenstrom 0,5 L/min betragen und konstant bleiben muss'
    const cut = snippet(src, 'volumenstrom', 40)
    expect(cut).toMatch(/^….*Volumenstrom.*…$/)
    expect(src.split(' ')).toEqual(expect.arrayContaining(cut.slice(1, -1).split(' ')))
  })
})
