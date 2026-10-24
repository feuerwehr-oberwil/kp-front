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
  /** one reference template with these entries (id = title), in this (the station's) order */
  const taktik = (...es: [title: string, diveraKeywords: string[]][]): ChecklistTemplate[] => [{
    id: 'el', kind: 'reference', title: 'EL', version: 1, source: 's',
    entries: es.map(([title, diveraKeywords]) => ({ id: title, title, keywords: [], diveraKeywords, content: [] })),
  }]
  const ids = (es: RefEntry[]) => es.map((e) => e.id)
  // the station's real Taktik · Stichworte and their alarm keywords (kp-front-data
  // checklists/el-taktik.json, 24.10.2026) – copied, the image has src/ only
  const station = taktik(
    ["Brand (allgemein)", ["BRAND","FEUER","GEBÄUDEBRAND","ZIMMERBRAND","WOHNUNGSBRAND"]],
    ["Brandmeldeanlagen", ["BMA","BRANDMELDEANLAGE","AUTOMATISCHE BRANDMELDUNG","FEHLALARM"]],
    ["Dachstockbrand", ["DACHSTOCKBRAND","DACHSTOCK","DACHBRAND"]],
    ["Hochhausbrand", ["HOCHHAUS","HOCHHAUSBRAND"]],
    ["Viele Personen (Schule / Heim / Saal)", ["SCHULE","SCHULHAUS","ALTERSHEIM","PFLEGEHEIM","HEIM","SPITAL","HOTEL"]],
    ["Tiefgaragenbrand", ["TIEFGARAGE","TIEFGARAGENBRAND","GARAGE","GARAGENBRAND","BRAND"]],
    ["E-Autobrand / Lithium-Akku", ["E-AUTO","ELEKTROAUTO","FAHRZEUGBRAND","AUTOBRAND","PKW BRAND","BRAND","E-BIKE","AKKU"]],
    ["Photovoltaik / Batteriespeicher", ["PHOTOVOLTAIK","PV","SOLAR"]],
    ["Flächen- / Waldbrand", ["BRAND","FLÄCHENBRAND","VEGETATIONSBRAND","WALD","WALDBRAND","WIESENBRAND"]],
    ["Kaminbrand", ["KAMINBRAND","KAMIN","SCHORNSTEIN","BRAND"]],
    ["Bauernhof (Gefahren / Brand)", ["BAUERNHOF","SCHEUNE","STALL","LANDWIRTSCHAFT","BRAND"]],
    ["Heuwehr", ["HEUWEHR","HEUSTOCK","HEU","BRAND"]],
    ["Sonstige Brände", ["SILOBRAND","SILO","TRAFOSTATION","TRAFO","PERSONENBRAND"]],
    ["Lüftereinsatz", ["LÜFTER","BELÜFTUNG","ENTRAUCHUNG"]],
    ["Verkehrsunfall", ["VERKEHRSUNFALL","VU","VKU","UNFALL","EINGEKLEMMTE PERSON","PKW","LKW"]],
    ["Tram / Bahn (BLT)", ["TRAM","BLT","VU SCHIENE","BAHN","PERSON UNTER TRAM"]],
    ["Gasleitungen", ["GAS","GASAUSTRITT","GASLECK","GASGERUCH","GASLEITUNG","EXPLOSION"]],
    ["Ölspur auf Strassen", ["ÖLSPUR","ÖL","VERUNREINIGUNG","STRASSE"]],
    ["Gefahrgut / ABC", ["ABC","GEFAHRGUT","CHEMIE","GEFAHRSTOFF","ATOMAR","BIOLOGISCH"]],
    ["Bergung aus Liftanlagen", ["LIFT","AUFZUG","PERSON IM LIFT","LIFTSTÖRUNG"]],
    ["Türöffnung", ["TÜRÖFFNUNG","TÜR","NOTÖFFNUNG","PERSON IN NOTLAGE"]],
    ["Person eingeklemmt / verschüttet", ["EINGEKLEMMTE PERSON","VERSCHÜTTET","PERSON EINGEKLEMMT","TECHNISCHE HILFELEISTUNG","EINSTURZ","EXPLOSION"]],
    ["Eisrettung", ["EISRETTUNG","PERSON IM EIS","EIS","PERSON IM WASSER"]],
    ["Räumung / Evakuation / Aufenthaltsprinzip", ["EVAKUATION","EVAKUIERUNG","RÄUMUNG"]],
    ["Amok / Bedrohungslage", ["AMOK","BEDROHUNGSLAGE","POLIZEILAGE"]],
    ["Wespen, Hornissen, Bienen", ["WESPEN","HORNISSEN","BIENEN","INSEKTEN","WESPENNEST"]],
    ["Tierrettung", ["TIERRETTUNG","TIER","GROSSTIERRETTUNG","TIER IN NOTLAGE"]],
    ["Med. USTÜ", ["MEDIZINISCHE UNTERSTÜTZUNG","TRAGHILFE","USTÜ","HUBRETTER"]],
    ["Baum zersägen (Spannungsverhältnis)", ["BAUM","BAUM AUF STRASSE","STURMSCHADEN","UMGESTÜRZTER BAUM"]],
    ["Wasserschaden", ["WASSERSCHADEN","WASSER IM KELLER","ÜBERSCHWEMMUNG"]],
    ["Hochwasser / Unwetter", ["HOCHWASSER","UNWETTER","ÜBERSCHWEMMUNG","ELEMENTAR","STURM"]],
  )
  const match = (title: string) => ids(matchEntries(station, title))

  it('matches a keyword in the title, the most specific first', () => {
    expect(match('Brand Tiefgarage Schloss')).toEqual(['Tiefgaragenbrand', 'Brand (allgemein)', 'E-Autobrand / Lithium-Akku', 'Flächen- / Waldbrand'])
  })
  it('takes a word that is a keyword itself as that hit only, not also as an ending', () => {
    expect(match('Zimmerbrand Schloss')).toEqual(['Brand (allgemein)'])
    expect(match('Tiefgaragenbrand UG')).toEqual(['Tiefgaragenbrand'])
  })
  it('gives none for a title without a keyword – a keyword inside a word is none', () => {
    expect(match('Kontrolle Schlossgasse 9')).toEqual([])
    expect(match('Wasserschaden Schlossgasse 9')).toEqual(['Wasserschaden'])
  })
  it('counts a word that ENDS in a keyword (owner 24.10.2026: «Kellerbrand» → brand)', () => {
    expect(match('Kellerbrand')[0]).toBe('Brand (allgemein)')
  })
  it('lets only keywords of 5+ letters match a word ending', () => {
    expect(match('Zimmerbrand Kreis')).not.toContain('Eisrettung')
    expect(match('VU Autobahn')).toEqual(['Verkehrsunfall'])
    expect(match('Katze Quartier')).toEqual([])
  })
  it('never matches a word ending in a street name', () => {
    expect(match('Brand Hauptstrasse 5')).not.toContain('Ölspur auf Strassen')
    expect(match('Brand Bahnhofstr.')).not.toContain('Ölspur auf Strassen')
    // a word before a house number is a street name too
    expect(match('Unfall Lindengarage 3')).toEqual(['Verkehrsunfall'])
    expect(match('Unfall Lindengarage')).toEqual(['Tiefgaragenbrand', 'Verkehrsunfall'])
  })
  it('matches a keyword of several words as a phrase', () => {
    const t = taktik(['ea', ['PKW BRAND', 'E-AUTO']])
    expect(ids(matchEntries(t, 'PKW Brand A2'))).toEqual(['ea'])
    expect(ids(matchEntries(t, 'E-Auto Garage'))).toEqual(['ea'])
    expect(matchEntries(t, 'Brand PKW')).toEqual([])
  })
  it('ranks by the longest keyword, then the most keywords hit, then the station order', () => {
    expect(match('Brand im Stall').slice(0, 2)).toEqual(['Bauernhof (Gefahren / Brand)', 'Brand (allgemein)'])
    const t = taktik(['wohnung', ['BRAND']], ['bauernhof', ['BRAND']], ['auto', ['BRAND']])
    expect(ids(matchEntries(t, 'Brand'))).toEqual(['wohnung', 'bauernhof', 'auto'])
  })

  // The reported case: one Stichwort, several answers, none of them derivable from the alarm text.
  it('offers every page a «VU Strasse» could turn out to need', () => {
    expect(match('VU Strasse Hauptstrasse 12')).toEqual(['Ölspur auf Strassen', 'Verkehrsunfall'])
  })

  it('caps how many it offers, so a broad keyword does not become a second list', () => {
    expect(match('Brand')).toHaveLength(4)
    expect(matchEntries(station, 'Brand', 2)).toHaveLength(2)
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
