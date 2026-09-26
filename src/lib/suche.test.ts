import { describe, expect, it } from 'vitest'
import {
  addBereich, addFoundPerson, addPerson, applySuchePatch, bereichStatusOf, diffSuche, emptySuche, findPlace,
  geretteteFromSuche, markFund, newPersonFromText, openBereiche, patchRows, pendingAsks, personEntwarnt, personGefunden,
  personIrrtuemlich, personKorrigiert, personPlace, personPrintRows, personUebergeben, personView, personenViews, placeLabel,
  renameBereich, rowOwner, sanitizeSuche, setBereichStatus, setPlacePoint, shownBereiche, sucheChangeWords, sucheFocusFor,
  sucheHeadLine, sucheLine, sucheLinkLabel, sucheOrte, suggestSuchePersonen, toggleAbgesucht, truppAt, truppPlace, truppShort,
  vermisstAbschlussMessage, vermisstCount, zielBereich,
  type SucheCx,
} from './suche'
import { mergeSuche, mergeWorkspace } from './mergeWorkspace'
import { floorLabel } from './whiteboard'
import type { SucheBereich, SucheDoc, SuchePerson } from '../types'

/** a deterministic world: ids count up, the clock is whatever the test says */
function world(start = '2026-09-23T19:36:00.000Z', tag = '') {
  let n = 0
  let at = start
  const cx = (): SucheCx => ({ at, newId: (p) => `${p}${tag}${++n}`, floorName: floorLabel })
  return { cx, set: (iso: string) => { at = iso } }
}
const t = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`
const clock = (iso: string) => iso.slice(11, 16)
const orte = (d: SucheDoc) => sucheOrte(d, floorLabel)
const idOf = (d: SucheDoc, name: string) => d.bereiche.find((b) => b.name === name)!.id

describe('Personen: the status is folded from the log', () => {
  it('a single person goes vermisst → gefunden → übergeben, and every step is a row with its words', () => {
    const w = world(t('20:08'))
    const a = addPerson(emptySuche(), { name: 'Tim Muster', wo: 'Technikraum', quelle: 'Hauswart' }, w.cx())
    expect(a.row.text).toBe('Vermisst: Tim Muster · zuletzt Technikraum · Quelle Hauswart')
    expect(personView(a.person)).toMatchObject({ status: 'vermisst', missing: 1, found: 0, vermisstAt: t('20:08') })
    w.set(t('20:16'))
    const g = personGefunden(a.doc, a.person.id, { trupp: 'Trupp 3', truppId: 'tr3', wo: 'Technikraum' }, w.cx())
    expect(g.rows.map((r) => r.text)).toEqual(['Gefunden: Tim Muster · Technikraum · Trupp 3'])
    expect(personView(g.doc.personen[0])).toMatchObject({ status: 'gefunden', missing: 0, found: 1, foundAt: t('20:16'), foundTrupp: 'Trupp 3' })
    w.set(t('20:21'))
    const h = personUebergeben(g.doc, a.person.id, { an: 'Rettungsdienst' }, w.cx())
    expect(h.rows[0].text).toBe('Übergeben: Tim Muster an Rettungsdienst')
    expect(personView(h.doc.personen[0])).toMatchObject({ status: 'uebergeben', an: 'Rettungsdienst', handedAt: t('20:21') })
    // a second «Gefunden» for somebody nobody misses any more writes nothing
    expect(personGefunden(h.doc, a.person.id, {}, w.cx()).rows).toEqual([])
  })

  it('«Gefunden» with «weiter an» is ONE row, and the place it names wears «Fund» without a row of its own', () => {
    const w = world()
    let d = addBereich(emptySuche(), { name: 'Keller' }, w.cx()).doc
    const a = addPerson(d, { name: 'Eva Beispiel' }, w.cx())
    const g = personGefunden(a.doc, a.person.id, { bereichId: idOf(a.doc, 'Keller'), an: 'Sammelplatz' }, w.cx())
    expect(g.rows).toHaveLength(1)
    expect(g.rows[0].text).toBe('Gefunden: Eva Beispiel · Keller · an Sammelplatz')
    expect(personView(g.doc.personen[0]).status).toBe('uebergeben')
    d = g.doc
    expect(shownBereiche(d, floorLabel)[0]).toMatchObject({ label: 'Keller', fund: true })
    expect(d.bereiche[0].log.map((r) => r.op)).toEqual(['angelegt']) // nothing written on the place
  })

  it('«+ Gefunden» writes ONE «Gefunden» row — no «Vermisst» with a time nobody reported', () => {
    const w = world(t('20:30'))
    const r = addFoundPerson(emptySuche(), { name: 'Ada Probe' }, { wo: 'Treppenhaus', trupp: 'Trupp 1' }, w.cx())
    expect(r.person.log.map((x) => x.op)).toEqual(['gefunden'])
    expect(r.row.text).toBe('Gefunden: Ada Probe · Treppenhaus · Trupp 1')
    const v = personView(r.person)
    expect(v).toMatchObject({ status: 'gefunden', found: 1, missing: 0 })
    expect(v.vermisstAt).toBeUndefined()
    expect(personPrintRows(r.doc, clock, floorLabel)[0].vermisst).toBe('–')
    // the place was new: it is on the list now, and she stands there
    expect(orte(r.doc).orte.map((o) => [o.label, o.personen.map((p) => p.label)])).toEqual([['Treppenhaus', ['Ada Probe']]])
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
    const a = addPerson(emptySuche(), { name: 'Klasse 3c', count: 22, wo: 'Werkraum' }, w.cx())
    expect(a.row.text).toBe('Vermisst: Klasse 3c (22 Pers.) · zuletzt Werkraum')
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
    const a = addPerson(emptySuche(), { name: 'Tim Mustr', wo: 'Keller' }, w.cx())
    const k = personKorrigiert(a.doc, a.person.id, { name: 'Tim Muster', wo: 'Aula' }, w.cx())
    expect(k.rows[0].text).toBe('Korrigiert: Tim Mustr · zuletzt Keller → Tim Muster · zuletzt Aula')
    expect(personView(k.doc.personen[0])).toMatchObject({ label: 'Tim Muster', wo: 'Aula', status: 'vermisst', bereichId: idOf(k.doc, 'Aula') })
    expect(k.doc.personen[0].name).toBe('Tim Mustr') // the record keeps what was first said
    // the new place is a place now, in the same act
    expect(k.doc.bereiche.map((b) => b.name)).toEqual(['Keller', 'Aula'])
    // nothing changed writes nothing — the spelling of a place is not a change
    expect(personKorrigiert(k.doc, a.person.id, { name: 'Tim Muster', wo: 'aula' }, w.cx()).rows).toEqual([])
    // a group's size, and back to «unbekannt»
    const g = personKorrigiert(k.doc, a.person.id, { name: 'Gruppe Werkstatt', count: 6, wo: '' }, w.cx())
    expect(personView(g.doc.personen[0])).toMatchObject({ group: true, count: 6, missing: 6, wo: undefined, bereichId: undefined })
    expect(orte(g.doc).unbekannt?.personen.map((p) => p.label)).toEqual(['Gruppe Werkstatt'])
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

describe('Orte: nothing is preset, and one list is by place', () => {
  it('an empty Suche is an empty list — no storey, no «ganzes Geschoss», nothing to tick', () => {
    const o = orte(emptySuche())
    expect(o).toEqual({ unbekannt: null, orte: [], missing: 0, done: 0, total: 0 })
    expect(sucheHeadLine(o)).toBe('')
  })

  it('«＋ Vermisst» at a NEW place creates the place in the same doc, and the person points at it', () => {
    const w = world(t('20:12'))
    const a = addPerson(emptySuche(), { name: 'Muster Tim', wo: '  Wohnung 2. OG   links ' }, w.cx())
    expect(a.doc.bereiche).toEqual([{ id: expect.any(String), name: 'Wohnung 2. OG links', createdAt: t('20:12'), log: [] }])
    expect(a.person.bereichId).toBe(a.doc.bereiche[0].id)
    expect(a.row.text).toBe('Vermisst: Muster Tim · zuletzt Wohnung 2. OG links')
    // a place already on the list is found, not doubled — case and accents do not make a second one
    const b = addPerson(a.doc, { name: 'Beispiel Anna', wo: 'wohnung 2. og LINKS' }, w.cx())
    expect(b.doc.bereiche).toHaveLength(1)
    expect(b.person.bereichId).toBe(a.person.bereichId)
    expect(b.person.wo).toBe('Wohnung 2. OG links') // the place's own spelling
    // and with no place at all, nobody invents one
    expect(addPerson(emptySuche(), { name: 'X', wo: '   ' }, w.cx()).doc.bereiche).toEqual([])
  })

  it('«Ort unbekannt» stands at the top; a place with somebody missing sorts first; abgesucht and nobody missing sinks', () => {
    const w = world(t('20:00'))
    let d = addBereich(emptySuche(), { name: 'Treppenhaus' }, w.cx()).doc
    d = addBereich(d, { name: 'Keller' }, w.cx()).doc
    d = addPerson(d, { name: 'Muster Tim', wo: 'Wohnung 2. OG links' }, w.cx()).doc
    d = addPerson(d, { name: 'Hauswart' }, w.cx()).doc
    d = addBereich(d, { name: 'Dachstock' }, w.cx()).doc
    // the Treppenhaus is abgesucht and somebody was found there
    d = addPerson(d, { name: 'Beispiel Anna', wo: 'Keller' }, w.cx()).doc
    d = personGefunden(d, d.personen[2].id, { bereichId: idOf(d, 'Treppenhaus'), trupp: 'Trupp 2' }, w.cx()).doc
    d = toggleAbgesucht(d, idOf(d, 'Treppenhaus'), w.cx()).doc
    const o = orte(d)
    expect(o.unbekannt?.personen.map((p) => p.label)).toEqual(['Hauswart'])
    expect(o.orte.map((x) => x.label)).toEqual(['Wohnung 2. OG links', 'Keller', 'Dachstock', 'Treppenhaus'])
    expect(o.orte.map((x) => [x.hot, x.quiet])).toEqual([[true, false], [false, false], [false, false], [false, true]])
    // a found person stands where she was FOUND
    expect(o.orte[3].personen.map((p) => p.label)).toEqual(['Beispiel Anna'])
    expect(o.orte[1].personen).toEqual([])
    expect(sucheHeadLine(o)).toBe('2 vermisst · 1/4 abgesucht')
  })

  it('a sweep with nobody missing says only what is searched — no «0 vermisst»', () => {
    const w = world()
    let d = addBereich(emptySuche(), { name: 'Scheune' }, w.cx()).doc
    d = addBereich(d, { name: 'Wohnhaus' }, w.cx()).doc
    d = toggleAbgesucht(d, idOf(d, 'Scheune'), w.cx()).doc
    expect(sucheHeadLine(orte(d))).toBe('1/2 abgesucht')
    expect(sucheHeadLine(orte(addPerson(emptySuche(), { name: 'A' }, w.cx()).doc))).toBe('1 vermisst')
  })

  it('the tick is abgesucht, and again back to offen — a status row each time', () => {
    const w = world(t('20:40'))
    let d = addBereich(emptySuche(), { name: 'Keller', trupp: { label: 'Trupp 2', id: 't2' } }, w.cx()).doc
    const id = idOf(d, 'Keller')
    const on = toggleAbgesucht(d, id, w.cx())
    expect(on.rows[0]).toMatchObject({ op: 'status', status: 'abgesucht', trupp: 'Trupp 2', text: 'Keller abgesucht · Trupp 2' })
    d = on.doc
    const off = toggleAbgesucht(d, id, w.cx())
    expect(off.rows[0]).toMatchObject({ status: 'offen', text: 'Keller offen' })
    expect(bereichStatusOf(off.doc.bereiche[0]).status).toBe('offen')
  })

  it('«＋ Bereich» with a Trupp is ONE step with two rows; a name that is there already is found', () => {
    const w = world()
    const r = addBereich(emptySuche(), { name: 'Dachstock', trupp: { label: 'Trupp 1', id: 't1' } }, w.cx())
    expect(r.rows.map((x) => x.text)).toEqual(['Bereich angelegt: Dachstock', 'Dachstock in Arbeit · Trupp 1'])
    expect(truppAt(shownBereiche(r.doc, floorLabel)[0])).toEqual({ label: 'Trupp 1', id: 't1' })
    const again = addBereich(r.doc, { name: 'dachstock' }, w.cx())
    expect(again).toMatchObject({ doc: r.doc, rows: [], id: r.id })
    expect(addBereich(emptySuche(), { name: '  ' }, w.cx()).id).toBeNull()
  })

  it('a rename keeps the people at the place (by id), and never makes two places read the same', () => {
    const w = world()
    let d = addPerson(emptySuche(), { name: 'Muster Tim', wo: 'Whg links' }, w.cx()).doc
    d = addBereich(d, { name: 'Keller' }, w.cx()).doc
    const id = idOf(d, 'Whg links')
    const r = renameBereich(d, id, 'Wohnung 2. OG links', w.cx())
    expect(r.rows[0].text).toBe('Bereich umbenannt: Whg links → Wohnung 2. OG links')
    expect(orte(r.doc).orte[0]).toMatchObject({ label: 'Wohnung 2. OG links', missing: 1 })
    expect(renameBereich(r.doc, id, 'keller', w.cx()).rows).toEqual([])
  })

  it('a person the composer reported («… vermisst», no place) is matched by words once such a place exists', () => {
    const w = world()
    const p: SuchePerson = { id: 'p1', name: 'Hauswart', wo: 'Keller', createdAt: t('20:00'), log: [{ id: 'r1', op: 'vermisst', at: t('20:00'), text: 'Vermisst: Hauswart' }] }
    let d: SucheDoc = { personen: [p], bereiche: [] }
    // no such place yet: the words stand as a group of their own, with nothing to tick
    expect(orte(d).orte).toMatchObject([{ key: 'txt:keller', label: 'Keller', hot: true }])
    expect(orte(d).orte[0].bereich).toBeUndefined()
    expect(orte(d).total).toBe(0)
    d = addBereich(d, { name: 'KELLER' }, w.cx()).doc
    expect(personPlace(d, personView(p), floorLabel)).toBe(d.bereiche[0].id)
    expect(orte(d).orte.map((o) => o.label)).toEqual(['KELLER'])
  })

  it('a step-1 document still reads: a touched storey is «1. OG», a part «1. OG Trakt 3»; a storey nobody touched is not shown', () => {
    const st = (f: number, log: SucheBereich['log'] = []): SucheBereich => ({ id: `sbg:k1:${f}`, floor: f, stack: 'k1', createdAt: t('19:36'), log })
    const d: SucheDoc = {
      bereiche: [
        st(2), // seeded by the machine on open, never touched
        st(1, [{ id: 'r1', op: 'status', status: 'abgesucht', at: t('20:10'), text: '1. OG abgesucht' }]),
        { id: 'sb9', floor: 1, name: 'Trakt 3', stack: 'k1', createdAt: t('19:40'), log: [{ id: 'r2', op: 'geteilt', at: t('19:40'), text: '1. OG geteilt: Trakt 3' }] },
        st(0),
      ],
      personen: [
        { id: 'p1', name: 'Tim Muster', floor: 1, wo: 'Trakt 3 Büro', createdAt: t('20:00'), log: [{ id: 'r3', op: 'vermisst', at: t('20:00'), text: 'Vermisst: Tim Muster · zuletzt 1. OG Trakt 3 Büro' }] },
        { id: 'p2', name: 'Ada Probe', floor: 0, createdAt: t('20:01'), log: [{ id: 'r4', op: 'vermisst', at: t('20:01'), text: 'Vermisst: Ada Probe · zuletzt EG' }] },
      ],
    }
    const clean = sanitizeSuche(JSON.parse(JSON.stringify(d)))!
    const o = orte(clean)
    // the untouched 2. OG is gone; the EG stays because somebody was last seen there
    expect(o.orte.map((x) => x.label)).toEqual(['1. OG Trakt 3', 'EG', '1. OG'])
    expect(o.orte.map((x) => x.personen.map((p) => p.label))).toEqual([['Tim Muster'], ['Ada Probe'], []])
    expect(placeLabel(clean.bereiche[2], floorLabel)).toBe('1. OG Trakt 3')
    expect(findPlace(clean, '1. og trakt 3', floorLabel)).toBe('sb9')
    expect(personPrintRows(clean, clock, floorLabel)[0].detail).toBe('zuletzt 1. OG Trakt 3')
    expect(sucheLine(clean, floorLabel, clock)).toBe('Suche: 3 Bereiche, 1 abgesucht · nicht abgesucht: 1. OG Trakt 3, EG')
    // a write on the old records works as on any other place
    const w = world()
    expect(toggleAbgesucht(clean, 'sbg:k1:0', w.cx()).rows[0].text).toBe('EG abgesucht')
    expect(personKorrigiert(clean, 'p2', { wo: 'Keller' }, w.cx()).rows[0].set).toEqual({ wo: 'Keller', bereichId: expect.any(String), floor: null })
  })

  it('«Fund melden» starts where the Trupp IS — its place in Arbeit, else its Ziel — never «zuletzt gesehen»', () => {
    const w = world(t('20:00'))
    let d = addBereich(emptySuche(), { name: 'Keller' }, w.cx()).doc
    d = addBereich(d, { name: 'Dachstock' }, w.cx()).doc
    expect(truppPlace(d, 't1', floorLabel, 'dachstock')).toBe(idOf(d, 'Dachstock'))
    w.set(t('20:05'))
    d = setBereichStatus(d, idOf(d, 'Keller'), 'inArbeit', { label: 'Trupp 1', id: 't1' }, w.cx()).doc
    expect(truppPlace(d, 't1', floorLabel, 'Dachstock')).toBe(idOf(d, 'Keller'))
    expect(truppPlace(d, 't9', floorLabel)).toBeUndefined()
  })

  it('a place can be put on the Karte or a plan, moved and taken off — one row each, nothing moved writes nothing', () => {
    const w = world()
    let d = addBereich(emptySuche(), { name: 'Scheune' }, w.cx()).doc
    const id = idOf(d, 'Scheune')
    const put = setPlacePoint(d, 'bereiche', id, { coord: [7.5, 47.5] }, w.cx())
    expect(put.rows[0]).toMatchObject({ op: 'ort', text: 'Scheune auf der Karte gesetzt' })
    d = put.doc
    expect(setPlacePoint(d, 'bereiche', id, { coord: [7.5, 47.5] }, w.cx()).rows).toEqual([])
    const moved = setPlacePoint(d, 'bereiche', id, { planId: 'gebaeude', x: 0.4, y: 0.3, floor: 1 }, w.cx())
    expect(moved.rows[0].text).toBe('Scheune auf dem Plan verschoben')
    const gone = setPlacePoint(moved.doc, 'bereiche', id, null, w.cx())
    expect(gone.rows[0].text).toBe('Scheune: Position entfernt')
    expect(gone.doc.bereiche[0]).not.toHaveProperty('point')
    // the ↶ of a move puts the old position back
    const back = applySuchePatch(moved.doc, diffSuche(d, moved.doc), 'undo')
    expect(back.bereiche[0].point).toEqual({ coord: [7.5, 47.5] })
  })
})

describe('the Trupp\'s Ziel', () => {
  it('names a place by its words, and a new Ziel is a new place — never a storey', () => {
    const w = world()
    const r = zielBereich(emptySuche(), '1. OG', w.cx())
    expect(r.doc.bereiche).toEqual([expect.objectContaining({ name: '1. OG' })])
    expect(r.doc.bereiche[0]).not.toHaveProperty('floor')
    expect(zielBereich(r.doc, '1. og', w.cx())).toMatchObject({ doc: r.doc, id: r.id, rows: [] })
  })

  it('an area whose Trupp is out carries the question until somebody answers it — nothing is written for it', () => {
    const w = world()
    const r = addBereich(emptySuche(), { name: 'Keller', trupp: { label: 'Trupp 4', id: 't4' } }, w.cx())
    const views = shownBereiche(r.doc, floorLabel)
    expect(pendingAsks(views, () => false)).toEqual([])
    expect(pendingAsks(views, (id) => id === 't4').map((u) => u.label)).toEqual(['Keller'])
    // «teilweise» answered it (N14): it keeps the Trupp, is NOT done, and asks no more
    const b = setBereichStatus(r.doc, r.id!, 'teilweise', undefined, w.cx())
    expect(b.rows[0]).toMatchObject({ status: 'teilweise', trupp: 'Trupp 4', text: 'Keller teilweise abgesucht · Trupp 4' })
    expect(pendingAsks(shownBereiche(b.doc, floorLabel), () => true)).toEqual([])
    expect(openBereiche(b.doc, floorLabel)).toEqual(['Keller'])
  })
})

describe('merge: records by id, logs as a union', () => {
  const base = (): SucheDoc => addPerson(emptySuche(), { name: 'Tim Muster' }, world(t('20:00')).cx()).doc

  it('two devices writing two things about the SAME person keep both rows', () => {
    const b = base()
    const id = b.personen[0].id
    const cxA: SucheCx = { at: t('20:16'), newId: () => 'srA', floorName: floorLabel }
    const cxB: SucheCx = { at: t('20:17'), newId: () => 'srB', floorName: floorLabel }
    const tablet = personGefunden(b, id, { trupp: 'Trupp 3' }, cxA).doc
    const phone = personUebergeben(b, id, { an: 'Rettungsdienst' }, cxB).doc
    const merged = mergeSuche(b, tablet, phone) as SucheDoc
    expect(merged.personen[0].log.map((r) => r.id)).toEqual([b.personen[0].log[0].id, 'srA', 'srB'])
    expect(personView(merged.personen[0]).status).toBe('uebergeben')
  })

  it('a place BOTH devices created from one Trupp Ziel (one derived id) keeps the rows of both', () => {
    const cx = (at: string, row: string): SucheCx => ({ at, newId: (p) => (p === 'sb' ? 'sb-k' : row), floorName: floorLabel })
    const tablet = addBereich(emptySuche(), { name: 'Keller', trupp: { label: 'Trupp 1', id: 't1' } }, cx(t('20:00'), 'rowTablet')).doc
    const phone = markFund(addBereich(emptySuche(), { name: 'Keller' }, cx(t('20:00'), 'rowAdd')).doc, 'sb-k', cx(t('20:01'), 'rowPhone')).doc
    const merged = mergeSuche(emptySuche(), tablet, phone) as SucheDoc
    expect(merged.bereiche).toHaveLength(1)
    expect(shownBereiche(merged, floorLabel)[0]).toMatchObject({ status: 'inArbeit', fund: true })
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
    const before = addBereich(addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx()).doc, { name: 'Keller' }, w.cx()).doc
    const after = personGefunden(before, before.personen[0].id, { trupp: 'Trupp 3' }, w.cx()).doc
    const patch = diffSuche(before, after)
    expect(patchRows(patch).map((r) => r.text)).toEqual(['Gefunden: Tim Muster · Trupp 3'])
    // meanwhile: a Trupp's Ziel marked the Keller «in Arbeit» and another device found a second person
    let live = setBereichStatus(after, idOf(after, 'Keller'), 'inArbeit', { label: 'Trupp 1', id: 't1' }, w.cx()).doc
    live = addPerson(live, { name: 'Ada Probe' }, w.cx()).doc
    const undone = applySuchePatch(live, patch, 'undo')
    expect(personView(undone.personen[0]).status).toBe('vermisst')
    expect(undone.personen.map((p) => p.name)).toEqual(['Tim Muster', 'Ada Probe'])
    expect(shownBereiche(undone, floorLabel)[0].status).toBe('inArbeit')
    // …and ↷ puts back that one row
    const redone = applySuchePatch(undone, patch, 'redo')
    expect(personView(redone.personen[0]).status).toBe('gefunden')
    expect(applySuchePatch(redone, patch, 'redo')).toEqual(redone) // twice is once
  })

  it('«＋ Vermisst» at a new place is ONE step: its ↶ takes the person AND the place', () => {
    const w = world()
    const start = addBereich(emptySuche(), { name: 'Keller' }, w.cx()).doc
    const a = addPerson(start, { name: 'Muster Tim', wo: 'Dachstock' }, w.cx())
    const patch = diffSuche(start, a.doc)
    expect(patch.created.map((c) => c.kind).sort()).toEqual(['bereiche', 'personen'])
    expect(applySuchePatch(a.doc, patch, 'undo')).toEqual(start)
    expect(applySuchePatch(start, patch, 'redo')).toEqual(a.doc)
  })

  it('a created record goes with its step, a renamed field comes back only while it is still the step\'s', () => {
    const w = world()
    const a = addPerson(emptySuche(), { name: 'Tim Muster' }, w.cx())
    const created = diffSuche(emptySuche(), a.doc)
    expect(created.created).toHaveLength(1)
    expect(applySuchePatch(a.doc, created, 'undo').personen).toEqual([])
    const d0 = addBereich(emptySuche(), { name: 'Trakt 3' }, w.cx()).doc
    const id = idOf(d0, 'Trakt 3')
    const d1 = renameBereich(d0, id, 'Aula', w.cx()).doc
    const rn = diffSuche(d0, d1)
    expect(applySuchePatch(d1, rn, 'undo').bereiche.find((b) => b.id === id)!.name).toBe('Trakt 3')
    // renamed again in between: the ↶ leaves the newer name alone
    const d2 = renameBereich(d1, id, 'Werkraum', w.cx()).doc
    expect(applySuchePatch(d2, rn, 'undo').bereiche.find((b) => b.id === id)!.name).toBe('Werkraum')
    expect(rowOwner(d1, d1.bereiche.find((b) => b.id === id)!.log[0].id)).toEqual({ bereichId: id })
  })
})

describe('the load gate', () => {
  it('keeps what it can and drops what would print nonsense', () => {
    expect(sanitizeSuche(undefined)).toBeUndefined()
    expect(sanitizeSuche('x')).toEqual(emptySuche())
    const s = sanitizeSuche({
      personen: [{ id: 'p1', name: 'A', count: Number.NaN, bereichId: 7, log: [{ id: 'r', op: 'vermisst', at: t('20:00'), text: 'x' }, { nope: 1 }] }, { name: 'no id' }],
      bereiche: [
        { id: 'sbg:k1:1', floor: 1 },
        { id: 'b2', name: 'Keller', point: { coord: [7.5, 'x'] } },
        { id: 'b3', name: 'Dach', point: { planId: 'gebaeude', x: 0.2, y: 0.8, floor: 2 } },
      ],
    })!
    expect(s.personen).toHaveLength(1)
    expect(s.personen[0].count).toBeUndefined()
    expect(s.personen[0]).not.toHaveProperty('bereichId')
    expect(s.personen[0].log).toHaveLength(1)
    expect(s.bereiche[0].log).toEqual([])
    expect(s.bereiche[1]).not.toHaveProperty('point')
    expect(s.bereiche[2].point).toEqual({ planId: 'gebaeude', x: 0.2, y: 0.8, floor: 2 })
  })
})

describe('doors: the composer', () => {
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
    expect(truppShort('Trupp 12')).toBe('T12')
  })
})

describe('the Rapport', () => {
  it('prints one line per person with its times, and the one Suche line', () => {
    const w = world(t('20:08'))
    let d = addPerson(emptySuche(), { name: 'Tim Muster', wo: 'Technikraum', quelle: 'Hauswart' }, w.cx()).doc
    w.set(t('20:10'))
    d = addPerson(d, { name: 'Klasse 3c', count: 22 }, w.cx()).doc
    d = addBereich(d, { name: 'Werkraum' }, w.cx()).doc
    w.set(t('20:16'))
    d = personGefunden(d, d.personen[0].id, { trupp: 'Trupp 3', wo: 'Z101' }, w.cx()).doc
    w.set(t('20:21'))
    d = personUebergeben(d, d.personen[0].id, { an: 'Rettungsdienst' }, w.cx()).doc
    d = personGefunden(d, d.personen[1].id, { n: 20 }, w.cx()).doc
    expect(personPrintRows(d, clock, floorLabel)).toEqual([
      { name: 'Tim Muster', detail: 'zuletzt Technikraum · Quelle Hauswart', vermisst: '20:08', gefunden: '20:16 · Trupp 3 · Z101', status: '20:21 an Rettungsdienst', open: false },
      { name: 'Klasse 3c (22 Pers.)', vermisst: '20:10', gefunden: '20 / 22 gefunden · 20:21', status: '2 vermisst', open: true },
    ])
    expect(sucheLine(d, floorLabel, clock)).toBe('Suche: 3 Bereiche, 0 abgesucht · nicht abgesucht: Technikraum, Werkraum, Z101')
    w.set(t('20:39'))
    for (const b of d.bereiche) d = setBereichStatus(d, b.id, 'abgesucht', undefined, w.cx()).doc
    expect(sucheLine(d, floorLabel, clock)).toBe('Suche: 3 Bereiche, alle abgesucht 20:39')
    expect(geretteteFromSuche(d)).toBe(21)
  })

  it('an Einsatz that never used the Suche prints no line and no hint', () => {
    expect(sucheLine(emptySuche(), floorLabel, clock)).toBeNull()
    expect(openBereiche(emptySuche(), floorLabel)).toEqual([])
    expect(personPrintRows(emptySuche(), clock, floorLabel)).toEqual([])
  })
})

describe('the walk-through of 25.09.2026 (round 2)', () => {
  it('a status this build does not know is skipped, never shown as «undefined»', () => {
    const b = { id: 'b1', name: 'Keller', createdAt: '', log: [
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
