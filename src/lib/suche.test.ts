import { describe, expect, it } from 'vitest'
import {
  addBereich, addPerson, emptySuche, ensureStoreyBereiche, findBereichByName, geretteteFromSuche, markFund, movedRows,
  newPersonFromText, openBereiche, personEntwarnt, personGefunden, personPrintRows, personUebergeben, personView,
  personenViews, renameBereich, rowOwner, sanitizeSuche, setBereichStatus, setOhneRest, splitStorey, storeyBadges,
  storeyBereichId, sucheAt, sucheGroups, sucheLine, sucheProgress, suggestSuchePersonen, truppShort, truppsOnStorey,
  vermisstCount, type SucheCx,
} from './suche'
import { mergeSuche, mergeWorkspace } from './mergeWorkspace'
import { floorLabel } from './whiteboard'
import type { SucheDoc } from '../types'

/** a deterministic world: ids count up, the clock is whatever the test says */
function world(start = '2026-09-23T19:36:00.000Z', tag = '') {
  let n = 0
  let at = start
  const cx = (): SucheCx => ({ at, newId: (p) => `${p}${tag}${++n}`, floorName: floorLabel })
  return { cx, set: (iso: string) => { at = iso } }
}
const t = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`
const clock = (iso: string) => iso.slice(11, 16)

describe('Personen: the status is folded from the log', () => {
  it('a single person goes vermisst → gefunden → übergeben, and every step is a row with its words', () => {
    const w = world(t('20:08'))
    const a = addPerson(emptySuche(), { name: 'Tim Muster', floor: 1, wo: 'Technikraum', quelle: 'Schulleitung' }, w.cx())
    expect(a.row.text).toBe('Vermisst: Tim Muster · zuletzt 1. OG Technikraum · Quelle Schulleitung')
    expect(personView(a.person)).toMatchObject({ status: 'vermisst', missing: 1, found: 0, vermisstAt: t('20:08') })
    w.set(t('20:16'))
    const g = personGefunden(a.doc, a.person.id, { trupp: 'Trupp 3', truppId: 'tr3', floor: 1, wo: 'Technikraum' }, w.cx())
    expect(g.rows[0].text).toBe('Gefunden: Tim Muster · 1. OG Technikraum · Trupp 3')
    const v = personView(g.doc.personen[0])
    expect(v).toMatchObject({ status: 'gefunden', missing: 0, found: 1, foundAt: t('20:16'), foundTrupp: 'Trupp 3', foundFloor: 1 })
    w.set(t('20:21'))
    const h = personUebergeben(g.doc, a.person.id, { an: 'Rettungsdienst' }, w.cx())
    expect(h.rows[0].text).toBe('Übergeben: Tim Muster an Rettungsdienst')
    expect(personView(h.doc.personen[0])).toMatchObject({ status: 'uebergeben', an: 'Rettungsdienst', handedAt: t('20:21') })
  })

  it('«weiter an» in the Gefunden form is a second row in the same step', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Eva Beispiel' }, w.cx())
    const g = personGefunden(a.doc, a.person.id, { an: 'Sammelplatz' }, w.cx())
    expect(g.rows.map((r) => r.op)).toEqual(['gefunden', 'uebergeben'])
    expect(personView(g.doc.personen[0]).status).toBe('uebergeben')
  })

  it('entwarnt takes a person off the missing count and off the Gerettete', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Mann, ca. 40' }, w.cx())
    const e = personEntwarnt(a.doc, a.person.id, w.cx())
    expect(e.rows[0].text).toBe('Entwarnung: Mann, ca. 40')
    expect(personView(e.doc.personen[0])).toMatchObject({ status: 'entwarnt', missing: 0, found: 0 })
    expect(vermisstCount(e.doc)).toBe(0)
    expect(geretteteFromSuche(e.doc)).toBe(0)
  })

  it('a group counts: 20 of 22 found is still 2 missing, and the rest completes it', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Klasse 3c + Lehrerin', count: 22, floor: 1 }, w.cx())
    expect(a.row.text).toBe('Vermisst: Klasse 3c + Lehrerin (22 Pers.) · zuletzt 1. OG')
    const g = personGefunden(a.doc, a.person.id, { n: 20, trupp: 'Trupp 2' }, w.cx())
    expect(g.rows[0].text).toBe('Gefunden: 20 von Klasse 3c + Lehrerin · Trupp 2')
    expect(personView(g.doc.personen[0])).toMatchObject({ group: true, count: 22, found: 20, missing: 2, status: 'vermisst' })
    expect(vermisstCount(g.doc)).toBe(2)
    expect(geretteteFromSuche(g.doc)).toBe(20)
    // «Gefunden» without a number takes whoever is left
    const rest = personGefunden(g.doc, a.person.id, {}, w.cx())
    expect(personView(rest.doc.personen[0])).toMatchObject({ found: 22, missing: 0, status: 'gefunden' })
    // a find never overshoots the group
    const over = personGefunden(g.doc, a.person.id, { n: 99 }, w.cx())
    expect(personView(over.doc.personen[0]).found).toBe(22)
  })

  it('a person without a name is still a person, and the count is not a name', () => {
    const w = world()
    const one = addPerson(emptySuche(), {}, w.cx())
    expect(one.row.text).toBe('Vermisst: Person ohne Namen')
    expect(personView(one.person).label).toBe('Person ohne Namen')
    const grp = addPerson(emptySuche(), { count: 3 }, w.cx())
    expect(personView(grp.person).label).toBe('Gruppe ohne Namen')
    // a count of 1 is one person, not a group of one
    expect(addPerson(emptySuche(), { name: 'X', count: 1 }, w.cx()).person.count).toBeUndefined()
  })

  it('the list puts the missing first, longest missing on top', () => {
    const w = world(t('19:50'))
    let d = addPerson(emptySuche(), { name: 'A' }, w.cx()).doc
    w.set(t('19:55')); d = addPerson(d, { name: 'B' }, w.cx()).doc
    w.set(t('20:00')); d = personGefunden(d, d.personen[0].id, {}, w.cx()).doc
    expect(personenViews(d).map((p) => p.label)).toEqual(['B', 'A'])
  })

  it('a find on a storey marks that storey\'s area «Fund» — the named part when the place names one', () => {
    const w = world()
    let d = splitStorey(emptySuche(), 1, ['Technik'], true, w.cx()).doc
    d = addPerson(d, { name: 'Tim Muster' }, w.cx()).doc
    const g = personGefunden(d, d.personen[0].id, { floor: 1, wo: 'Technikraum' }, w.cx())
    const part = g.doc.bereiche.find((b) => b.name === 'Technik')!
    expect(part.log[part.log.length - 1]).toMatchObject({ op: 'fund', personId: d.personen[0].id, text: 'Fund: 1. OG Technik · Tim Muster' })
    // …and a place no part is named after lands on the storey row, seeded under its derived id
    const e = personGefunden(addPerson(emptySuche(), { name: 'Z' }, w.cx()).doc, 'sp' + '0', { floor: 2 }, w.cx())
    expect(e.rows).toEqual([]) // unknown person id: nothing at all
    const p2 = addPerson(emptySuche(), { name: 'Z' }, w.cx())
    const g2 = personGefunden(p2.doc, p2.person.id, { floor: 2 }, w.cx())
    expect(g2.doc.bereiche.find((b) => b.id === storeyBereichId(2))?.log.map((r) => r.op)).toEqual(['fund'])
  })
})

describe('Bereiche: storeys come into being by themselves', () => {
  it('seeding is idempotent and uses derived ids — the same doc comes back when nothing is missing', () => {
    const d1 = ensureStoreyBereiche(emptySuche(), [-1, 0, 1, 2], t('19:36'))
    expect(d1.bereiche.map((b) => b.id)).toEqual(['sbg-1', 'sbg0', 'sbg1', 'sbg2'])
    expect(ensureStoreyBereiche(d1, [0, 1, 2, -1], t('20:00'))).toBe(d1)
    // a second device seeding the same stack writes the SAME records — the merge keeps one each
    const d2 = ensureStoreyBereiche(emptySuche(), [2, 1, 0, -1], t('19:37'))
    const merged = mergeSuche(undefined, d1, d2) as SucheDoc
    expect(merged.bereiche.map((b) => b.id).sort()).toEqual(['sbg-1', 'sbg0', 'sbg1', 'sbg2'])
  })

  it('an unseeded storey shows as a virtual «ganzes Geschoss · offen», and a write seeds it', () => {
    const w = world()
    const groups = sucheGroups(emptySuche(), [0, 1], floorLabel)
    expect(groups.map((g) => [g.label, g.units.map((u) => [u.short, u.status, !!u.virtual])])).toEqual([
      ['1. OG', [['ganzes Geschoss', 'offen', true]]],
      ['EG', [['ganzes Geschoss', 'offen', true]]],
    ])
    const r = setBereichStatus(emptySuche(), storeyBereichId(0), 'abgesucht', { label: 'Trupp 1', id: 'tr1' }, w.cx())
    expect(r.rows[0].text).toBe('EG abgesucht · Trupp 1')
    expect(r.doc.bereiche.map((b) => b.id)).toEqual(['sbg0'])
  })

  it('a split storey counts its parts plus the rest, and is complete only when all are abgesucht', () => {
    const w = world()
    let d = ensureStoreyBereiche(emptySuche(), [0, 1, 2], t('19:36'))
    const s = splitStorey(d, 1, ['Trakt 2', 'Trakt 3', 'Technik', 'Lehrerzimmer', ' trakt 3 '], true, w.cx())
    expect(s.rows[0].text).toBe('1. OG geteilt: Trakt 2, Trakt 3, Technik, Lehrerzimmer')
    d = s.doc
    let g1 = sucheGroups(d, [0, 1, 2], floorLabel).find((g) => g.floor === 1)!
    expect(g1.units.map((u) => u.short)).toEqual(['Trakt 2', 'Trakt 3', 'Technik', 'Lehrerzimmer', 'übriges Geschoss'])
    expect([g1.done, g1.total]).toEqual([0, 5])
    // the parts cover the whole storey: the rest leaves the count
    d = setOhneRest(d, 1, true, w.cx()).doc
    g1 = sucheGroups(d, [0, 1, 2], floorLabel).find((g) => g.floor === 1)!
    expect(g1.total).toBe(4)
    const t2 = d.bereiche.find((b) => b.name === 'Trakt 2')!.id
    const lz = d.bereiche.find((b) => b.name === 'Lehrerzimmer')!.id
    d = setBereichStatus(d, t2, 'abgesucht', { label: 'Trupp 3' }, w.cx()).doc
    d = setBereichStatus(d, lz, 'abgesucht', undefined, w.cx()).doc
    d = setBereichStatus(d, storeyBereichId(0), 'abgesucht', undefined, w.cx()).doc
    const groups = sucheGroups(d, [0, 1, 2], floorLabel)
    expect(storeyBadges(groups)).toEqual({
      2: { text: '0/1', complete: false, active: false },
      1: { text: '2/4', complete: false, active: false },
      0: { text: '1/1', complete: true, active: false },
    })
    expect(sucheProgress(groups)).toEqual({ done: 3, total: 6 })
  })

  it('«in Arbeit · Trupp 4» then «abgesucht» keeps the Trupp; a repeated tap writes nothing', () => {
    const w = world()
    let d = addBereich(ensureStoreyBereiche(emptySuche(), [1], t('19:36')), { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const id = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const a = setBereichStatus(d, id, 'inArbeit', { label: 'Trupp 4', id: 'tr4' }, w.cx())
    expect(a.rows[0].text).toBe('1. OG Trakt 3 in Arbeit · Trupp 4')
    d = a.doc
    expect(setBereichStatus(d, id, 'inArbeit', { label: 'Trupp 4', id: 'tr4' }, w.cx()).doc).toBe(d)
    const b = setBereichStatus(d, id, 'abgesucht', undefined, w.cx())
    expect(b.rows[0].text).toBe('1. OG Trakt 3 abgesucht · Trupp 4')
    const v = sucheGroups(b.doc, [1], floorLabel)[0].units[0]
    expect(v).toMatchObject({ status: 'abgesucht', trupp: 'Trupp 4', truppId: 'tr4' })
    // back to «offen» clears the Trupp
    const o = setBereichStatus(b.doc, id, 'offen', undefined, w.cx())
    expect(o.rows[0].text).toBe('1. OG Trakt 3 offen')
    expect(sucheGroups(o.doc, [1], floorLabel)[0].units[0].trupp).toBeUndefined()
  })

  it('without a Gebäude an area is a named row of its own', () => {
    const w = world()
    const r = addBereich(emptySuche(), { name: 'Ufer Nord' }, w.cx())
    expect(r.id).toBeTruthy()
    const groups = sucheGroups(r.doc, [], floorLabel)
    expect(groups.map((g) => [g.key, g.label, g.units.map((u) => u.full)])).toEqual([['none', 'Ohne Geschoss', ['Ufer Nord']]])
    // the same name again is found, not duplicated
    expect(addBereich(r.doc, { name: 'ufer nord' }, w.cx()).id).toBe(r.id)
  })

  it('a typed name finds its area: a storey label, «storey part», or a bare part on that storey', () => {
    const w = world()
    let d = ensureStoreyBereiche(emptySuche(), [0, 1], t('19:36'))
    d = splitStorey(d, 0, ['Trakt 3'], true, w.cx()).doc
    const part = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    expect(findBereichByName(d, 'EG', undefined, floorLabel)).toBe('sbg0')
    expect(findBereichByName(d, '1. og ganzes geschoss', undefined, floorLabel)).toBe('sbg1')
    expect(findBereichByName(d, 'EG Trakt 3', undefined, floorLabel)).toBe(part)
    expect(findBereichByName(d, 'trakt 3', 0, floorLabel)).toBe(part)
    expect(findBereichByName(d, 'trakt 3', 1, floorLabel)).toBeNull()
    expect(findBereichByName(d, 'Aula', undefined, floorLabel)).toBeNull()
  })

  it('renaming says both names, and «Fund» is a mark beside the status', () => {
    const w = world()
    let d = addBereich(emptySuche(), { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const id = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const r = renameBereich(d, id, 'Aula', w.cx())
    expect(r.rows[0].text).toBe('Bereich umbenannt: 1. OG Trakt 3 → 1. OG Aula')
    d = markFund(r.doc, id, undefined, w.cx()).doc
    const v = sucheGroups(d, [1], floorLabel)[0].units.find((u) => u.id === id)!
    expect(v).toMatchObject({ short: 'Aula', status: 'offen', fund: true })
    // renaming a storey row (it has no name) is refused
    expect(renameBereich(d, storeyBereichId(1), 'X', w.cx()).rows).toEqual([])
  })
})

describe('merge: records by id, logs as a union', () => {
  const base = (): SucheDoc => {
    const w = world(t('20:00'))
    return addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx()).doc
  }

  it('two devices writing two things about the SAME person keep both rows', () => {
    const b = base()
    const id = b.personen[0].id
    const tablet = personGefunden(b, id, { trupp: 'Trupp 3' }, { at: t('20:16'), newId: () => 'srA', floorName: floorLabel }).doc
    const phone = personUebergeben(b, id, { an: 'Rettungsdienst' }, { at: t('20:17'), newId: () => 'srB', floorName: floorLabel }).doc
    const merged = mergeSuche(b, tablet, phone) as SucheDoc
    expect(merged.personen[0].log.map((r) => r.id)).toEqual([b.personen[0].log[0].id, 'srA', 'srB'])
    expect(personView(merged.personen[0]).status).toBe('uebergeben')
  })

  it('a row one side took back (↶) stays gone; a concurrent new record from the other survives', () => {
    const w = world(t('20:10'))
    const b = personGefunden(base(), base().personen[0].id, {}, w.cx()).doc
    const undone: SucheDoc = { ...b, personen: b.personen.map((p) => ({ ...p, log: p.log.slice(0, 1) })) }
    const other = addPerson(b, { name: 'Ada Probe' }, w.cx()).doc
    const merged = mergeSuche(b, undone, other) as SucheDoc
    expect(merged.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Ada Probe'])
    expect(personView(merged.personen[0]).status).toBe('vermisst')
  })

  it('rides the workspace merge, and an incident without a Suche stays without one', () => {
    const b = base()
    const w = world(t('20:30'), 'b')
    const mine = { suche: addPerson(b, { name: 'Eva Beispiel' }, w.cx()).doc }
    const out = mergeWorkspace({ suche: b }, mine, { suche: b }) as { suche: SucheDoc }
    expect(out.suche.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Eva Beispiel'])
    expect(mergeWorkspace({}, {}, {}).suche).toBeUndefined()
  })
})

describe('undo, replay and the load gate', () => {
  it('movedRows names what a step took back, in its own words', () => {
    const w = world()
    const before = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx()).doc
    const after = personGefunden(before, before.personen[0].id, { trupp: 'Trupp 3' }, w.cx()).doc
    expect(movedRows(after, before).map((r) => r.text)).toEqual(['Gefunden: Tim Muster · Trupp 3'])
    expect(movedRows(before, after)).toEqual([])
    expect(rowOwner(after, after.personen[0].log[1].id)).toEqual({ personId: after.personen[0].id })
  })

  it('sucheAt shows the search as it stood: later records and later rows are gone', () => {
    const w = world(t('20:00'))
    let d = addPerson(emptySuche(), { name: 'A' }, w.cx()).doc
    w.set(t('20:10')); d = personGefunden(d, d.personen[0].id, {}, w.cx()).doc
    w.set(t('20:20')); d = addPerson(d, { name: 'B' }, w.cx()).doc
    const at = sucheAt(d, Date.parse(t('20:05')))
    expect(at.personen.map((p) => [p.name, personView(p).status])).toEqual([['A', 'vermisst']])
    expect(vermisstCount(sucheAt(d, Date.parse(t('20:25'))))).toBe(1)
  })

  it('the load gate keeps what it can and drops what would print nonsense', () => {
    expect(sanitizeSuche(undefined)).toBeUndefined()
    expect(sanitizeSuche('x')).toEqual(emptySuche())
    const s = sanitizeSuche({
      personen: [{ id: 'p1', name: 'A', count: Number.NaN, log: [{ id: 'r', op: 'vermisst', at: t('20:00'), text: 'x' }, { nope: 1 }] }, { name: 'no id' }],
      bereiche: [{ id: 'sbg1', floor: 1 }],
    })!
    expect(s.personen).toHaveLength(1)
    expect(s.personen[0].count).toBeUndefined()
    expect(s.personen[0].log).toHaveLength(1)
    expect(s.bereiche[0].log).toEqual([])
  })
})

describe('doors: the composer and the Trupps', () => {
  it('a known name in the sentence offers the missing person; a word that merely occurs inside does not', () => {
    const w = world()
    let d = addPerson(emptySuche(), { name: 'Eva Beispiel' }, w.cx()).doc
    d = addPerson(d, { name: 'Tim Muster' }, w.cx()).doc
    const views = personenViews(d)
    expect(suggestSuchePersonen('eva bei', views).map((p) => p.label)).toEqual(['Eva Beispiel'])
    expect(suggestSuchePersonen('ma', views)).toEqual([])
    // somebody already found is not offered «vermisst → gefunden» again
    d = personGefunden(d, d.personen[0].id, {}, w.cx()).doc
    expect(suggestSuchePersonen('eva', personenViews(d))).toEqual([])
  })

  it('«… vermisst» in the sentence proposes a new person named by the words before it', () => {
    expect(newPersonFromText('Eva Beispiel vermisst, zuletzt 2. OG')).toBe('Eva Beispiel')
    expect(newPersonFromText('Vermisst gemeldet')).toBeNull()
    expect(newPersonFromText('Lüfter in Stellung')).toBeNull()
  })

  it('the Trupp on the storey comes first: in Arbeit on one of its areas, then its marker', () => {
    const w = world()
    let d = ensureStoreyBereiche(emptySuche(), [1], t('19:36'))
    d = setBereichStatus(d, 'sbg1', 'inArbeit', { label: 'Trupp 4', id: 't4' }, w.cx()).doc
    const trupps = [{ id: 't3', label: 'Trupp 3', short: 'T3' }, { id: 't4', label: 'Trupp 4', short: 'T4' }]
    expect(truppsOnStorey(d, 1, trupps, [{ truppId: 't3', floor: 1 }, { truppId: 't4', floor: 1 }]).map((x) => x.id)).toEqual(['t4', 't3'])
    expect(truppsOnStorey(d, 2, trupps, [{ truppId: 't3', floor: 1 }])).toEqual([])
    expect(truppShort('Trupp 12')).toBe('T12')
  })
})

describe('the Rapport', () => {
  it('prints one line per person with its times, and the one Suche line', () => {
    const w = world(t('20:08'))
    let d = ensureStoreyBereiche(emptySuche(), [0, 1], t('19:36'))
    d = addPerson(d, { name: 'Tim Muster', floor: 1, wo: 'Technikraum', quelle: 'Schulleitung' }, w.cx()).doc
    w.set(t('20:10'))
    d = addPerson(d, { name: 'Klasse 3c', count: 22 }, w.cx()).doc
    w.set(t('20:16'))
    d = personGefunden(d, d.personen[0].id, { trupp: 'Trupp 3', floor: 1, wo: 'Z101' }, w.cx()).doc
    w.set(t('20:21'))
    d = personUebergeben(d, d.personen[0].id, { an: 'Rettungsdienst' }, w.cx()).doc
    d = personGefunden(d, d.personen[1].id, { n: 20 }, w.cx()).doc
    const rows = personPrintRows(d, clock, floorLabel)
    expect(rows).toEqual([
      { name: 'Tim Muster', detail: 'zuletzt 1. OG Technikraum · Quelle Schulleitung', vermisst: '20:08', gefunden: '20:16 · Trupp 3 · 1. OG Z101', status: '20:21 an Rettungsdienst', open: false },
      { name: 'Klasse 3c (22 Pers.)', vermisst: '20:10', gefunden: '20 / 22 gefunden · 20:21', status: '2 vermisst', open: true },
    ])
    const groups = sucheGroups(d, [0, 1], floorLabel)
    expect(sucheLine(d, groups, clock)).toBe('Suche: 2 Bereiche, 0 abgesucht · nicht abgesucht: 1. OG, EG')
    expect(openBereiche(d, groups)).toEqual(['1. OG', 'EG'])
    w.set(t('20:39'))
    d = setBereichStatus(d, 'sbg0', 'abgesucht', undefined, w.cx()).doc
    d = setBereichStatus(d, 'sbg1', 'abgesucht', undefined, w.cx()).doc
    expect(sucheLine(d, sucheGroups(d, [0, 1], floorLabel), clock)).toBe('Suche: 2 Bereiche, alle abgesucht 20:39')
    expect(geretteteFromSuche(d)).toBe(21)
  })

  it('an Einsatz that never used the Suche prints no line and no hint', () => {
    const d = ensureStoreyBereiche(emptySuche(), [0, 1, 2], t('19:36'))
    const groups = sucheGroups(d, [0, 1, 2], floorLabel)
    expect(sucheLine(d, groups, clock)).toBeNull()
    expect(openBereiche(d, groups)).toEqual([])
    expect(personPrintRows(d, clock, floorLabel)).toEqual([])
  })
})
