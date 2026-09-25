import { describe, expect, it } from 'vitest'
import {
  addBereich, addFoundPerson, addPerson, applySuchePatch, diffSuche, emptySuche, ensureStoreyBereiche, findBereichByName,
  geretteteFromSuche, markFund, newPersonFromText, openBereiche, patchRows, pendingAsks, personEntwarnt, personGefunden,
  personIrrtuemlich, personKorrigiert, personPrintRows, personUebergeben, personView, personenViews, renameBereich, rowOwner,
  sanitizeSuche, setBereichStatus, setOhneRest, splitStorey, stackKeyOf, storeyBadges, storeyBereichId, sucheGroups, sucheLine,
  sucheProgress, suggestSuchePersonen, truppShort, truppsOnStorey, vermisstCount, zielBereich, sucheChangeWords, sucheLinkLabel,
  bereichStatusOf, sucheFocusFor, vermisstAbschlussMessage,
  type SucheCx, type SucheStack,
} from './suche'
import { mergeSuche, mergeWorkspace } from './mergeWorkspace'
import { floorLabel } from './whiteboard'
import { patchTouches } from './useSucheActions'
import { sucheRecordKey } from './undoKeys'
import type { SucheDoc } from '../types'

const K = 'k1' // the Gebäude every test stands in
const stack = (floors: number[], key = K): SucheStack => ({ key, floors, floorName: floorLabel })
const sid = (f: number, key = K) => storeyBereichId(f, key)

/** a deterministic world: ids count up, the clock is whatever the test says */
function world(start = '2026-09-23T19:36:00.000Z', tag = '') {
  let n = 0
  let at = start
  const cx = (key = K): SucheCx => ({ at, newId: (p) => `${p}${tag}${++n}`, floorName: floorLabel, stack: key })
  return { cx, set: (iso: string) => { at = iso } }
}
const t = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`
const clock = (iso: string) => iso.slice(11, 16)

describe('Personen: the status is folded from the log', () => {
  it('a single person goes vermisst → gefunden → übergeben, and every step is a row with its words', () => {
    const w = world(t('20:08'))
    const a = addPerson(emptySuche(), { name: 'Tim Muster', floor: 1, wo: 'Technikraum', quelle: 'Hauswart' }, w.cx())
    expect(a.row.text).toBe('Vermisst: Tim Muster · zuletzt 1. OG Technikraum · Quelle Hauswart')
    expect(personView(a.person)).toMatchObject({ status: 'vermisst', missing: 1, found: 0, vermisstAt: t('20:08') })
    w.set(t('20:16'))
    const g = personGefunden(a.doc, a.person.id, { trupp: 'Trupp 3', truppId: 'tr3', floor: 1, wo: 'Technikraum' }, w.cx())
    expect(g.rows.map((r) => r.text)).toEqual(['Gefunden: Tim Muster · 1. OG Technikraum · Trupp 3'])
    expect(personView(g.doc.personen[0])).toMatchObject({ status: 'gefunden', missing: 0, found: 1, foundAt: t('20:16'), foundTrupp: 'Trupp 3', foundFloor: 1 })
    w.set(t('20:21'))
    const h = personUebergeben(g.doc, a.person.id, { an: 'Rettungsdienst' }, w.cx())
    expect(h.rows[0].text).toBe('Übergeben: Tim Muster an Rettungsdienst')
    expect(personView(h.doc.personen[0])).toMatchObject({ status: 'uebergeben', an: 'Rettungsdienst', handedAt: t('20:21') })
  })

  it('«Gefunden» with «weiter an» is ONE row, and the area it names wears «Fund» without a row of its own', () => {
    const w = world()
    let d = splitStorey(emptySuche(), 1, ['Technik'], true, w.cx()).doc
    const a = addPerson(d, { name: 'Eva Beispiel' }, w.cx())
    const g = personGefunden(a.doc, a.person.id, { floor: 1, wo: 'Technikraum', an: 'Sammelplatz' }, w.cx())
    expect(g.rows).toHaveLength(1)
    expect(g.rows[0].text).toBe('Gefunden: Eva Beispiel · 1. OG Technikraum · an Sammelplatz')
    expect(personView(g.doc.personen[0]).status).toBe('uebergeben')
    d = g.doc
    const part = sucheGroups(d, stack([1])).find((x) => x.floor === 1)!.units.find((u) => u.short === 'Technik')!
    expect(part.fund).toBe(true)
    expect(d.bereiche.find((b) => b.name === 'Technik')!.log.map((r) => r.op)).toEqual([]) // nothing written on the area
  })

  it('«+ Gefunden» writes ONE «Gefunden» row — no «Vermisst» with a time nobody reported', () => {
    const w = world(t('20:30'))
    const r = addFoundPerson(emptySuche(), { name: 'Ada Probe' }, { floor: 0, trupp: 'Trupp 1' }, w.cx())
    expect(r.person.log.map((x) => x.op)).toEqual(['gefunden'])
    expect(r.row.text).toBe('Gefunden: Ada Probe · EG · Trupp 1')
    const v = personView(r.person)
    expect(v).toMatchObject({ status: 'gefunden', found: 1, missing: 0 })
    expect(v.vermisstAt).toBeUndefined()
    expect(personPrintRows(r.doc, clock, floorLabel)[0].vermisst).toBe('–')
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
    const a = addPerson(emptySuche(), { name: 'Klasse 3c', count: 22, floor: 1 }, w.cx())
    expect(a.row.text).toBe('Vermisst: Klasse 3c (22 Pers.) · zuletzt 1. OG')
    const g = personGefunden(a.doc, a.person.id, { n: 20, trupp: 'Trupp 2' }, w.cx())
    expect(g.rows[0].text).toBe('Gefunden: 20 von Klasse 3c · Trupp 2')
    expect(personView(g.doc.personen[0])).toMatchObject({ group: true, count: 22, found: 20, missing: 2, status: 'vermisst' })
    expect(vermisstCount(g.doc)).toBe(2)
    expect(geretteteFromSuche(g.doc)).toBe(20)
    const rest = personGefunden(g.doc, a.person.id, {}, w.cx())
    expect(personView(rest.doc.personen[0])).toMatchObject({ found: 22, missing: 0, status: 'gefunden' })
    const over = personGefunden(g.doc, a.person.id, { n: 99 }, w.cx())
    expect(personView(over.doc.personen[0]).found).toBe(22)
  })

  it('a person without a name is still a person, and the count is not a name', () => {
    const w = world()
    const one = addPerson(emptySuche(), {}, w.cx())
    expect(one.row.text).toBe('Vermisst: Person ohne Namen')
    expect(personView(addPerson(emptySuche(), { count: 3 }, w.cx()).person).label).toBe('Gruppe ohne Namen')
    expect(addPerson(emptySuche(), { name: 'X', count: 1 }, w.cx()).person.count).toBeUndefined()
  })

  it('the list puts the missing first, longest missing on top', () => {
    const w = world(t('19:50'))
    let d = addPerson(emptySuche(), { name: 'A' }, w.cx()).doc
    w.set(t('19:55')); d = addPerson(d, { name: 'B' }, w.cx()).doc
    w.set(t('20:00')); d = personGefunden(d, d.personen[0].id, {}, w.cx()).doc
    expect(personenViews(d).map((p) => p.label)).toEqual(['B', 'A'])
  })

  it('a correction is a row: name, group size and «zuletzt gesehen» change, the first report stays in the log', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Tim Mustr', floor: 1 }, w.cx())
    const k = personKorrigiert(a.doc, a.person.id, { name: 'Tim Muster', floor: 2, wo: 'Aula' }, w.cx())
    expect(k.rows[0].text).toBe('Korrigiert: Tim Mustr · zuletzt 1. OG → Tim Muster · zuletzt 2. OG Aula')
    expect(personView(k.doc.personen[0])).toMatchObject({ label: 'Tim Muster', floor: 2, wo: 'Aula', status: 'vermisst' })
    expect(k.doc.personen[0].name).toBe('Tim Mustr') // the record keeps what was first said
    // nothing changed writes nothing
    expect(personKorrigiert(k.doc, a.person.id, { name: 'Tim Muster', floor: 2, wo: 'Aula' }, w.cx()).rows).toEqual([])
    // a group's size, and back to «unbekannt»
    const g = personKorrigiert(k.doc, a.person.id, { name: 'Gruppe Werkstatt', count: 6 }, w.cx())
    expect(personView(g.doc.personen[0])).toMatchObject({ group: true, count: 6, missing: 6, floor: undefined })
  })

  it('«irrtümlich erfasst» withdraws the record: it counts nowhere and is not printed', () => {
    const w = world()
    let d = addPerson(emptySuche(), { name: 'Eva Beispiel' }, w.cx()).doc
    d = addPerson(d, { name: 'Tim Muster' }, w.cx()).doc
    const r = personIrrtuemlich(d, d.personen[0].id, w.cx())
    expect(r.rows[0].text).toBe('Irrtümlich erfasst: Eva Beispiel')
    expect(personView(r.doc.personen[0])).toMatchObject({ status: 'irrtuemlich', missing: 0, found: 0 })
    expect(vermisstCount(r.doc)).toBe(1)
    expect(personenViews(r.doc).map((p) => p.label)).toEqual(['Tim Muster', 'Eva Beispiel']) // withdrawn last
    expect(personPrintRows(r.doc, clock, floorLabel).map((p) => p.name)).toEqual(['Tim Muster'])
    expect(personIrrtuemlich(r.doc, d.personen[0].id, w.cx()).rows).toEqual([]) // once is enough
  })
})

describe('Bereiche: storeys come into being by themselves, per Gebäude', () => {
  it('seeding is idempotent and uses derived ids — the same doc comes back when nothing is missing', () => {
    const d1 = ensureStoreyBereiche(emptySuche(), [-1, 0, 1, 2], t('19:36'), K)
    expect(d1.bereiche.map((b) => b.id)).toEqual([sid(-1), sid(0), sid(1), sid(2)])
    expect(ensureStoreyBereiche(d1, [0, 1, 2, -1], t('20:00'), K)).toBe(d1)
  })

  it('a REPLACED building starts fresh: its storeys are other records and inherit no state', () => {
    const w = world()
    const d = setBereichStatus(emptySuche(), sid(0, 'old'), 'abgesucht', undefined, w.cx('old')).doc
    const oldG = sucheGroups(d, stack([0], 'old'))
    const newG = sucheGroups(d, stack([0], 'new'))
    expect(oldG[0].units[0].status).toBe('abgesucht')
    expect(newG[0].units[0]).toMatchObject({ status: 'offen', virtual: true })
    expect(stackKeyOf({ pack: { bindingId: 'b1' } })).not.toBe(stackKeyOf({ pack: { bindingId: 'b2' } }))
    expect(stackKeyOf({ src: [[[0, 0], [1, 0]]] })).not.toBe(stackKeyOf({ src: [[[0, 0], [2, 0]]] }))
    expect(stackKeyOf(null)).toBe('')
  })

  it('an unseeded storey shows as a virtual «ganzes Geschoss · offen», and a write seeds it', () => {
    const w = world()
    const groups = sucheGroups(emptySuche(), stack([0, 1]))
    expect(groups.map((g) => [g.label, g.units.map((u) => [u.short, u.status, !!u.virtual])])).toEqual([
      ['1. OG', [['ganzes Geschoss', 'offen', true]]],
      ['EG', [['ganzes Geschoss', 'offen', true]]],
    ])
    const r = setBereichStatus(emptySuche(), sid(0), 'abgesucht', { label: 'Trupp 1', id: 'tr1' }, w.cx())
    expect(r.rows[0].text).toBe('EG abgesucht · Trupp 1')
    expect(r.doc.bereiche.map((b) => [b.id, b.stack])).toEqual([[sid(0), K]])
  })

  it('a split storey counts its parts plus the rest, and is complete only when all are abgesucht', () => {
    const w = world()
    let d = ensureStoreyBereiche(emptySuche(), [0, 1, 2], t('19:36'), K)
    const s = splitStorey(d, 1, ['Trakt 2', 'Trakt 3', 'Technik', 'Werkraum', ' trakt 3 '], true, w.cx())
    expect(s.rows[0].text).toBe('1. OG geteilt: Trakt 2, Trakt 3, Technik, Werkraum')
    d = s.doc
    let g1 = sucheGroups(d, stack([0, 1, 2])).find((g) => g.floor === 1)!
    expect(g1.units.map((u) => u.short)).toEqual(['Trakt 2', 'Trakt 3', 'Technik', 'Werkraum', 'übriges Geschoss'])
    d = setOhneRest(d, 1, true, w.cx()).doc
    g1 = sucheGroups(d, stack([0, 1, 2])).find((g) => g.floor === 1)!
    expect(g1.total).toBe(4)
    const t2 = d.bereiche.find((b) => b.name === 'Trakt 2')!.id
    const wr = d.bereiche.find((b) => b.name === 'Werkraum')!.id
    d = setBereichStatus(d, t2, 'abgesucht', { label: 'Trupp 3' }, w.cx()).doc
    d = setBereichStatus(d, wr, 'abgesucht', undefined, w.cx()).doc
    d = setBereichStatus(d, sid(0), 'abgesucht', undefined, w.cx()).doc
    const groups = sucheGroups(d, stack([0, 1, 2]))
    expect(storeyBadges(groups)).toEqual({
      2: { text: '0/1', complete: false, active: false },
      1: { text: '2/4', complete: false, active: false },
      0: { text: '1/1', complete: true, active: false },
    })
    expect(sucheProgress(groups)).toEqual({ done: 3, total: 6 })
  })

  it('«in Arbeit · Trupp 4» then «abgesucht» keeps the Trupp; a repeated tap writes nothing', () => {
    const w = world()
    let d = addBereich(ensureStoreyBereiche(emptySuche(), [1], t('19:36'), K), { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const id = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const a = setBereichStatus(d, id, 'inArbeit', { label: 'Trupp 4', id: 'tr4' }, w.cx())
    expect(a.rows[0].text).toBe('1. OG Trakt 3 in Arbeit · Trupp 4')
    d = a.doc
    expect(setBereichStatus(d, id, 'inArbeit', { label: 'Trupp 4', id: 'tr4' }, w.cx()).doc).toBe(d)
    const b = setBereichStatus(d, id, 'abgesucht', undefined, w.cx())
    expect(b.rows[0].text).toBe('1. OG Trakt 3 abgesucht · Trupp 4')
    expect(sucheGroups(b.doc, stack([1]))[0].units[0]).toMatchObject({ status: 'abgesucht', trupp: 'Trupp 4', truppId: 'tr4' })
    const o = setBereichStatus(b.doc, id, 'offen', undefined, w.cx())
    expect(o.rows[0].text).toBe('1. OG Trakt 3 offen')
  })

  it('an area whose Trupp is out carries the question until somebody answers it — nothing is written for it', () => {
    const w = world()
    const d = setBereichStatus(emptySuche(), sid(1), 'inArbeit', { label: 'Trupp 4', id: 't4' }, w.cx()).doc
    const groups = sucheGroups(d, stack([1]))
    expect(pendingAsks(groups, () => false)).toEqual([])
    expect(pendingAsks(groups, (id) => id === 't4').map((u) => u.id)).toEqual([sid(1)])
    const answered = setBereichStatus(d, sid(1), 'offen', undefined, w.cx(), 'teilweise abgesucht')
    expect(answered.rows[0].text).toBe('1. OG teilweise abgesucht')
    expect(pendingAsks(sucheGroups(answered.doc, stack([1])), () => true)).toEqual([])
  })

  it('without a Gebäude an area is a named row of its own, and saying so is a row', () => {
    const w = world()
    const r = addBereich(emptySuche(), { name: 'Ufer Nord' }, w.cx(''))
    expect(r.rows[0].text).toBe('Bereich angelegt: Ufer Nord')
    expect(sucheGroups(r.doc, stack([], '')).map((g) => [g.key, g.units.map((u) => u.full)])).toEqual([['none', ['Ufer Nord']]])
    expect(addBereich(r.doc, { name: 'ufer nord' }, w.cx('')).id).toBe(r.id)
  })

  it('a typed name finds its area — every label the Ziel chips offer, «übriges Geschoss» included', () => {
    const w = world()
    let d = ensureStoreyBereiche(emptySuche(), [0, 1], t('19:36'), K)
    d = splitStorey(d, 0, ['Trakt 3'], true, w.cx()).doc
    const part = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const st = stack([0, 1])
    expect(findBereichByName(d, 'EG', undefined, st)).toBe(sid(0))
    expect(findBereichByName(d, '1. og ganzes geschoss', undefined, st)).toBe(sid(1))
    expect(findBereichByName(d, 'EG übriges Geschoss', undefined, st)).toBe(sid(0))
    expect(findBereichByName(d, 'EG Trakt 3', undefined, st)).toBe(part)
    expect(findBereichByName(d, 'trakt 3', 0, st)).toBe(part)
    expect(findBereichByName(d, 'trakt 3', 1, st)).toBeNull()
    // every chip label maps back to its own area — none creates a fake part
    const labels = sucheGroups(d, st).flatMap((g) => g.units)
    for (const u of labels) expect(zielBereich(d, u.full, undefined, st, w.cx())).toMatchObject({ doc: d, id: u.id })
  })

  it('a storey Ziel names the storey even before it was seeded; a new name creates the part', () => {
    const w = world()
    const st = stack([0, 1])
    expect(zielBereich(emptySuche(), 'EG', undefined, st, w.cx())).toMatchObject({ id: sid(0), rows: [] })
    const aula = zielBereich(emptySuche(), '1. OG Aula', undefined, st, w.cx())
    expect(aula.doc.bereiche.find((b) => b.id === aula.id)).toMatchObject({ floor: 1, name: 'Aula', stack: K })
  })

  it('renaming says both names, and «Fund» is a mark beside the status', () => {
    const w = world()
    let d = addBereich(emptySuche(), { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const id = d.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const r = renameBereich(d, id, 'Aula', w.cx())
    expect(r.rows[0].text).toBe('Bereich umbenannt: 1. OG Trakt 3 → 1. OG Aula')
    d = markFund(r.doc, id, w.cx()).doc
    expect(sucheGroups(d, stack([1]))[0].units.find((u) => u.id === id)).toMatchObject({ short: 'Aula', status: 'offen', fund: true })
    expect(renameBereich(d, sid(1), 'X', w.cx()).rows).toEqual([])
  })
})

describe('merge: records by id, logs as a union', () => {
  const base = (): SucheDoc => addPerson(emptySuche(), { name: 'Tim Muster' }, world(t('20:00')).cx()).doc

  it('two devices writing two things about the SAME person keep both rows', () => {
    const b = base()
    const id = b.personen[0].id
    const cxA: SucheCx = { at: t('20:16'), newId: () => 'srA', floorName: floorLabel, stack: K }
    const cxB: SucheCx = { at: t('20:17'), newId: () => 'srB', floorName: floorLabel, stack: K }
    const tablet = personGefunden(b, id, { trupp: 'Trupp 3' }, cxA).doc
    const phone = personUebergeben(b, id, { an: 'Rettungsdienst' }, cxB).doc
    const merged = mergeSuche(b, tablet, phone) as SucheDoc
    expect(merged.personen[0].log.map((r) => r.id)).toEqual([b.personen[0].log[0].id, 'srA', 'srB'])
    expect(personView(merged.personen[0]).status).toBe('uebergeben')
  })

  it('a storey BOTH devices seeded (one derived id, no ancestor) keeps the rows of both — the logs are compared, not the ids', () => {
    const tablet = setBereichStatus(emptySuche(), sid(0), 'inArbeit', { label: 'Trupp 1', id: 't1' }, { at: t('20:00'), newId: () => 'rowTablet', floorName: floorLabel, stack: K }).doc
    const phone = markFund(emptySuche(), sid(0), { at: t('20:01'), newId: () => 'rowPhone', floorName: floorLabel, stack: K }).doc
    const merged = mergeSuche(emptySuche(), tablet, phone) as SucheDoc
    expect(merged.bereiche).toHaveLength(1)
    expect(merged.bereiche[0].log.map((r) => r.id)).toEqual(['rowTablet', 'rowPhone'])
    const u = sucheGroups(merged, stack([0]))[0].units[0]
    expect(u).toMatchObject({ status: 'inArbeit', fund: true })
  })

  it('a row one side took back (↶) stays gone; a concurrent new record from the other survives', () => {
    const w = world(t('20:10'), 'x')
    const b = personGefunden(base(), base().personen[0].id, {}, w.cx()).doc
    const undone: SucheDoc = { ...b, personen: b.personen.map((p) => ({ ...p, log: p.log.slice(0, 1) })) }
    const other = addPerson(b, { name: 'Ada Probe' }, w.cx()).doc
    const merged = mergeSuche(b, undone, other) as SucheDoc
    expect(merged.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Ada Probe'])
    expect(personView(merged.personen[0]).status).toBe('vermisst')
  })

  it('rides the workspace merge, and an incident without a Suche stays without one', () => {
    const b = base()
    const mine = { suche: addPerson(b, { name: 'Eva Beispiel' }, world(t('20:30'), 'b').cx()).doc }
    const out = mergeWorkspace({ suche: b }, mine, { suche: b }) as { suche: SucheDoc }
    expect(out.suche.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Eva Beispiel'])
    expect(mergeWorkspace({}, {}, {}).suche).toBeUndefined()
  })
})

describe('undo: a step takes back exactly what it added', () => {
  it('↶ removes the step\'s own row and nothing the machine or another device wrote since', () => {
    const w = world()
    const before = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx()).doc
    const after = personGefunden(before, before.personen[0].id, { trupp: 'Trupp 3' }, w.cx()).doc
    const patch = diffSuche(before, after)
    expect(patchRows(patch).map((r) => r.text)).toEqual(['Gefunden: Tim Muster · Trupp 3'])
    // meanwhile: a Trupp's Ziel marked the EG «in Arbeit» and another device found a second person
    let live = setBereichStatus(after, sid(0), 'inArbeit', { label: 'Trupp 1', id: 't1' }, w.cx()).doc
    live = addPerson(live, { name: 'Ada Probe' }, w.cx()).doc
    const undone = applySuchePatch(live, patch, 'undo')
    expect(personView(undone.personen[0]).status).toBe('vermisst')
    expect(undone.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Ada Probe'])
    expect(sucheGroups(undone, stack([0]))[0].units[0].status).toBe('inArbeit')
    // …and ↷ puts back that one row
    const redone = applySuchePatch(undone, patch, 'redo')
    expect(personView(redone.personen[0]).status).toBe('gefunden')
    expect(applySuchePatch(redone, patch, 'redo')).toEqual(redone) // twice is once
  })

  it('a created record goes with its step, a renamed field comes back only while it is still the step\'s', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx())
    const created = diffSuche(emptySuche(), a.doc)
    expect(created.created).toHaveLength(1)
    expect(applySuchePatch(a.doc, created, 'undo').personen).toEqual([])
    const d0 = addBereich(emptySuche(), { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const id = d0.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const d1 = renameBereich(d0, id, 'Aula', w.cx()).doc
    const rn = diffSuche(d0, d1)
    expect(applySuchePatch(d1, rn, 'undo').bereiche.find((b) => b.id === id)!.name).toBe('Trakt 3')
    // renamed again in between: the ↶ leaves the newer name alone
    const d2 = renameBereich(d1, id, 'Werkraum', w.cx()).doc
    expect(applySuchePatch(d2, rn, 'undo').bereiche.find((b) => b.id === id)!.name).toBe('Werkraum')
    expect(rowOwner(d1, d1.bereiche.find((b) => b.id === id)!.log[0].id)).toEqual({ bereichId: id })
  })

  it('a step names the records its inverse writes, so a merge that left them alone keeps it (#234)', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx()).doc
    const pid = a.personen[0].id
    expect(patchTouches(diffSuche(emptySuche(), a))).toEqual([sucheRecordKey('personen', pid)])
    const d0 = addBereich(a, { name: 'Trakt 3', floor: 1 }, w.cx()).doc
    const bid = d0.bereiche.find((b) => b.name === 'Trakt 3')!.id
    const d1 = personGefunden(renameBereich(d0, bid, 'Aula', w.cx()).doc, pid, { trupp: 'Trupp 3' }, w.cx()).doc
    expect(patchTouches(diffSuche(d0, d1)).sort()).toEqual([sucheRecordKey('bereiche', bid), sucheRecordKey('personen', pid)].sort())
  })
})

describe('the load gate', () => {
  it('keeps what it can and drops what would print nonsense', () => {
    expect(sanitizeSuche(undefined)).toBeUndefined()
    expect(sanitizeSuche('x')).toEqual(emptySuche())
    const s = sanitizeSuche({
      personen: [{ id: 'p1', name: 'A', count: Number.NaN, log: [{ id: 'r', op: 'vermisst', at: t('20:00'), text: 'x' }, { nope: 1 }] }, { name: 'no id' }],
      bereiche: [{ id: sid(1), floor: 1 }],
    })!
    expect(s.personen).toHaveLength(1)
    expect(s.personen[0].count).toBeUndefined()
    expect(s.personen[0].log).toHaveLength(1)
    expect(s.bereiche[0].log).toEqual([])
  })
})

describe('doors: the composer and the Trupps', () => {
  it('EVERY typed word must start a word of the name — a sentence that merely contains it offers nothing', () => {
    const w = world()
    let d = addPerson(emptySuche(), { name: 'Eva Beispiel' }, w.cx()).doc
    d = addPerson(d, { name: 'Tim Muster' }, w.cx()).doc
    const views = personenViews(d)
    expect(suggestSuchePersonen('eva bei', views).map((p) => p.label)).toEqual(['Eva Beispiel'])
    expect(suggestSuchePersonen('eva', views).map((p) => p.label)).toEqual(['Eva Beispiel'])
    expect(suggestSuchePersonen('eva im Keller angetroffen', views)).toEqual([])
    expect(suggestSuchePersonen('va', views)).toEqual([])
    d = personGefunden(d, d.personen[0].id, {}, w.cx()).doc
    expect(suggestSuchePersonen('eva', personenViews(d))).toEqual([])
  })

  it('«… vermisst» proposes the NAME right before it — the trailing phrase, never the whole sentence', () => {
    expect(newPersonFromText('Tim Muster vermisst, zuletzt 2. OG')).toBe('Tim Muster')
    expect(newPersonFromText('Meldung Hauswart: Tim Muster vermisst')).toBe('Tim Muster')
    expect(newPersonFromText('laut Hauswart Tim Muster vermisst')).toBe('Tim Muster')
    expect(newPersonFromText('Klasse 3c vermisst')).toBe('Klasse 3c')
    expect(newPersonFromText('eine person wird vermisst')).toBeNull()
    expect(newPersonFromText('Vermisst gemeldet')).toBeNull()
    expect(newPersonFromText('Lüfter in Stellung')).toBeNull()
  })

  it('the chosen change is said in words the Verlauf row carries', () => {
    expect(sucheLinkLabel({ kind: 'gefunden', personId: 'p1', label: 'Tim Muster' })).toBe('Tim Muster · vermisst → gefunden')
    expect(sucheChangeWords({ kind: 'gefunden', personId: 'p1', label: 'Tim Muster' })).toBe('Tim Muster gefunden')
    expect(sucheChangeWords({ kind: 'neu', name: 'Eva Beispiel' })).toBe('Eva Beispiel vermisst')
  })

  it('the Trupp on the storey comes first: in Arbeit on one of its areas, then its marker', () => {
    const w = world()
    const d = setBereichStatus(ensureStoreyBereiche(emptySuche(), [1], t('19:36'), K), sid(1), 'inArbeit', { label: 'Trupp 4', id: 't4' }, w.cx()).doc
    const trupps = [{ id: 't3', label: 'Trupp 3', short: 'T3' }, { id: 't4', label: 'Trupp 4', short: 'T4' }]
    expect(truppsOnStorey(d, 1, trupps, [{ truppId: 't3', floor: 1 }, { truppId: 't4', floor: 1 }]).map((x) => x.id)).toEqual(['t4', 't3'])
    expect(truppsOnStorey(d, 2, trupps, [{ truppId: 't3', floor: 1 }])).toEqual([])
    expect(truppShort('Trupp 12')).toBe('T12')
  })
})

describe('the Rapport', () => {
  it('prints one line per person with its times, and the one Suche line', () => {
    const w = world(t('20:08'))
    let d = ensureStoreyBereiche(emptySuche(), [0, 1], t('19:36'), K)
    d = addPerson(d, { name: 'Tim Muster', floor: 1, wo: 'Technikraum', quelle: 'Hauswart' }, w.cx()).doc
    w.set(t('20:10'))
    d = addPerson(d, { name: 'Klasse 3c', count: 22 }, w.cx()).doc
    w.set(t('20:16'))
    d = personGefunden(d, d.personen[0].id, { trupp: 'Trupp 3', floor: 1, wo: 'Z101' }, w.cx()).doc
    w.set(t('20:21'))
    d = personUebergeben(d, d.personen[0].id, { an: 'Rettungsdienst' }, w.cx()).doc
    d = personGefunden(d, d.personen[1].id, { n: 20 }, w.cx()).doc
    expect(personPrintRows(d, clock, floorLabel)).toEqual([
      { name: 'Tim Muster', detail: 'zuletzt 1. OG Technikraum · Quelle Hauswart', vermisst: '20:08', gefunden: '20:16 · Trupp 3 · 1. OG Z101', status: '20:21 an Rettungsdienst', open: false },
      { name: 'Klasse 3c (22 Pers.)', vermisst: '20:10', gefunden: '20 / 22 gefunden · 20:21', status: '2 vermisst', open: true },
    ])
    const groups = sucheGroups(d, stack([0, 1]))
    expect(sucheLine(d, groups, clock)).toBe('Suche: 2 Bereiche, 0 abgesucht · nicht abgesucht: 1. OG, EG')
    expect(openBereiche(d, groups)).toEqual(['1. OG', 'EG'])
    w.set(t('20:39'))
    d = setBereichStatus(d, sid(0), 'abgesucht', undefined, w.cx()).doc
    d = setBereichStatus(d, sid(1), 'abgesucht', undefined, w.cx()).doc
    expect(sucheLine(d, sucheGroups(d, stack([0, 1])), clock)).toBe('Suche: 2 Bereiche, alle abgesucht 20:39')
    expect(geretteteFromSuche(d)).toBe(21)
  })

  it('an Einsatz that never used the Suche prints no line and no hint', () => {
    const d = ensureStoreyBereiche(emptySuche(), [0, 1, 2], t('19:36'), K)
    const groups = sucheGroups(d, stack([0, 1, 2]))
    expect(sucheLine(d, groups, clock)).toBeNull()
    expect(openBereiche(d, groups)).toEqual([])
    expect(personPrintRows(d, clock, floorLabel)).toEqual([])
  })
})

describe('the walk-through of 25.09.2026 (round 2)', () => {
  it('N14 · «teilweise abgesucht» is its own status: it keeps the Trupp, and it is NOT done', () => {
    const w = world(t('20:10'))
    const a = setBereichStatus(emptySuche(), sid(2), 'inArbeit', { label: 'Trupp 1', id: 't1' }, w.cx())
    w.set(t('20:19'))
    const b = setBereichStatus(a.doc, sid(2), 'teilweise', undefined, w.cx())
    expect(b.rows[0]).toMatchObject({ status: 'teilweise', trupp: 'Trupp 1', truppId: 't1', text: '2. OG teilweise abgesucht · Trupp 1' })
    const groups = sucheGroups(b.doc, stack([2]))
    expect(groups[0].units[0]).toMatchObject({ status: 'teilweise', trupp: 'Trupp 1' })
    expect(sucheProgress(groups)).toEqual({ done: 0, total: 1 })
    expect(openBereiche(b.doc, groups)).toEqual(['2. OG'])
    expect(sucheLine(b.doc, groups, clock)).toBe('Suche: 1 Bereiche, 0 abgesucht · nicht abgesucht: 2. OG')
    // …and it asks nothing more: the Trupp answered
    expect(pendingAsks(groups, () => true)).toEqual([])
  })

  it('a status this build does not know is skipped, never shown as «undefined»', () => {
    const b = { id: sid(0), floor: 0, stack: K, createdAt: '', log: [
      { id: 'r1', op: 'status' as const, status: 'inArbeit' as const, at: t('20:00'), text: '' },
      { id: 'r2', op: 'status' as const, status: 'verraucht' as never, at: t('20:05'), text: '' },
    ] }
    expect(bereichStatusOf(b).status).toBe('inArbeit')
  })

  it('N7 · «Entwarnen» and «Irrtümlich erfasst» carry why and who said so, in the row', () => {
    const w = world(t('20:08'))
    const a = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx())
    const e = personEntwarnt(a.doc, a.person.id, w.cx(), { grund: 'zu Hause', quelle: 'Angehörige' })
    expect(e.rows[0]).toMatchObject({ grund: 'zu Hause', quelle: 'Angehörige', text: 'Entwarnung: Tim Muster · zu Hause · Quelle Angehörige' })
    const i = personIrrtuemlich(a.doc, a.person.id, w.cx(), { grund: '  ' })
    expect(i.rows[0].text).toBe('Irrtümlich erfasst: Tim Muster')
    expect(i.rows[0]).not.toHaveProperty('grund')
  })

  it('N6 · the Abschluss names the count and the first names of who is still missing', () => {
    const w = world(t('20:08'))
    let d = addPerson(emptySuche(), { name: 'Klasse 4b', count: 8 }, w.cx()).doc
    d = addPerson(d, { name: 'Tim Muster' }, w.cx()).doc
    expect(vermisstAbschlussMessage(d)).toBe('9 Personen noch vermisst: Klasse 4b (8), Tim Muster.')
    const one = addPerson(emptySuche(), { name: 'Ada Probe' }, w.cx())
    expect(vermisstAbschlussMessage(one.doc)).toBe('1 Person noch vermisst: Ada Probe.')
    // withdrawn, stood down or found: nobody to ask about
    expect(vermisstAbschlussMessage(personIrrtuemlich(one.doc, one.person.id, w.cx()).doc)).toBeNull()
    expect(vermisstAbschlussMessage(emptySuche())).toBeNull()
    // more than three records: three names in the list's order, and the rest counted
    let many = emptySuche()
    for (const n of ['A Eins', 'B Zwei', 'C Drei', 'D Vier']) many = addPerson(many, { name: n }, w.cx()).doc
    const shown = personenViews(many).slice(0, 3).map((v) => v.label).join(', ')
    expect(vermisstAbschlussMessage(many)).toBe(`4 Personen noch vermisst: ${shown} +1.`)
  })

  it('N17 · a plain open is the LIST — a jump from before never comes back', () => {
    const jump = sucheFocusFor(null, { personId: 'p1' })
    expect(jump).toEqual({ personId: 'p1', bereichId: undefined, nonce: 1 })
    expect(sucheFocusFor(jump, undefined)).toBeNull()
    expect(sucheFocusFor(jump, { bereichId: 'b1' })).toEqual({ personId: undefined, bereichId: 'b1', nonce: 2 })
  })
})
