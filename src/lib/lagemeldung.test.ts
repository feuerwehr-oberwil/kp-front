import { afterEach, describe, expect, it } from 'vitest'
import {
  anchorFor, changeOf, changeSummary, collectFacts, composeLagemeldung, diffFacts, findAnchor, finalLines, fitBudget,
  radioSeconds, radioText, wordCount,
  type LageAnchorRef, type LageFact, type LageInput, type LageLine,
} from './lagemeldung'
import { __setErgData } from './erg'
import { hhmm } from './format'
import type { BuildingInfo } from './api/building'
import type { OpenReminder } from './reminders'
import type { TimelineEvent, Trupp } from '../types'

// One Einsatz, as in the design (f3.html §02): Brand MFH, Hauptstrasse 12 — Alarm 21:12.
const T0 = Date.parse('2026-10-09T19:12:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const clk = (min: number) => hhmm(new Date(T0 + min * 60_000))

const DOCTRINE = { contactIntervalMin: 10, contactGraceSec: 60, alarmBar: 60, alarmBarRueckzug: 60, cylinderLiters: 6.8, estConsumptionLPerMin: 60 }

let seq = 0
const row = (min: number, text: string, extra: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id: extra.id ?? `r${++seq}`, t: clk(min), at: at(min), icon: 'type', text, kind: 'journal', ...extra })

const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 'tr1', name: 'Meier Anna', no: 1, status: 'aktiv', kind: 'atemschutz', auftrag: 'retten', ziel: '3. OG',
  entryPressureBar: 300, entryTime: at(8), lastContactTime: at(8), ...over,
})

function input(over: Partial<LageInput> = {}): LageInput {
  return {
    now: T0 + 5 * 60_000,
    title: 'Brand MFH',
    symbols: [],
    trupps: [],
    doctrine: DOCTRINE,
    rows: [],
    reminders: [],
    fahrzeuge: [],
    fleet: [{ id: 'tlf', label: 'TLF' }, { id: 'adl', label: 'ADL' }, { id: 'mtf', label: 'MTF' }],
    present: 0,
    ...over,
  }
}

const anchorRef = (min: number, facts: Record<string, string | number | string[]>, declined?: string[]): LageAnchorRef =>
  ({ id: `a${min}`, at: T0 + min * 60_000, anchor: { v: 1, mode: 'seit', facts, ...(declined ? { declined } : {}) } })

const fact = (key: string, facts: LageFact[]) => facts.find((f) => f.key === key)
const line = (key: string, lines: LageLine[]) => lines.find((l) => l.key === key)

afterEach(() => { __setErgData({ version: '', un: {} }) })

describe('findAnchor', () => {
  it('is the newest row carrying a Lagemeldung, skipping retracted ones', () => {
    const a1 = row(5, 'Lagemeldung 21:17: …', { id: 'x1', lagemeldung: { v: 1, mode: 'seit', facts: { a: 1 } } })
    const a2 = row(25, 'Lagemeldung 21:37: …', { id: 'x2', lagemeldung: { v: 1, mode: 'seit', facts: { a: 2 } } })
    const gone = row(30, 'Lagemeldung 21:42: …', { id: 'x3', retracted: true, lagemeldung: { v: 1, mode: 'seit', facts: { a: 3 } } })
    expect(findAnchor([a2, gone, row(40, 'x'), a1])?.id).toBe('x2')
    expect(findAnchor([row(1, 'nothing')])).toBeNull()
  })
  it('ignores a malformed snapshot', () => {
    const bad = row(5, 'x', { lagemeldung: { v: 2 } as never })
    expect(findAnchor([bad])).toBeNull()
  })
})

describe('L2 · Trupp in Alarm (tier 0, Zuerst)', () => {
  it('a Trupp at its Alarmdruck leads the report, with where it is', () => {
    const t = trupp({ id: 'tr2', no: 2, auftrag: 'loeschen', ziel: '2. OG', lastPressureBar: 55, lastPressureTime: at(24), lastContactTime: at(24) })
    const f = fact('as.alarm.tr2', collectFacts(input({ now: T0 + 25 * 60_000, trupps: [t] })))!
    expect(f).toMatchObject({ tier: 0, slot: 'zuerst', value: 'pressure|Trupp 2' })
    expect(f.text).toBe('Trupp 2 Alarmdruck 55 bar, Rückzug, 2. OG.')
  })
  it('an overdue Trupp says how long it has been silent', () => {
    const t = trupp({ lastContactTime: at(8) })
    const f = fact('as.alarm.tr1', collectFacts(input({ now: T0 + 20 * 60_000, trupps: [t] })))!
    expect(f.value).toBe('contact|Trupp 1')
    expect(f.text).toBe('Trupp 1 überfällig, kein Funkkontakt seit 12′, 3. OG.')
  })
  it('«Kontakt fällig» is the AS-Überwacher\'s, not the ELZ\'s — and names are never said (S8)', () => {
    const t = trupp({ lastContactTime: at(8) })
    const facts = collectFacts(input({ now: T0 + 18 * 60_000 + 30_000, trupps: [t] }))
    expect(fact('as.alarm.tr1', facts)).toBeUndefined()
    const overdue = collectFacts(input({ now: T0 + 25 * 60_000, trupps: [t] }))
    expect(overdue.map((f) => f.text).join(' ')).not.toContain('Meier')
  })
  it('a removed Trupp is not reported', () => {
    const t = trupp({ removedAt: at(10) })
    expect(fact('as.alarm.tr1', collectFacts(input({ now: T0 + 30 * 60_000, trupps: [t] })))).toBeUndefined()
  })
  it('the alarm over → one ERLEDIGT line naming the Trupp', () => {
    const { lines } = diffFacts([], anchorRef(25, { 'as.alarm.tr2': 'pressure|Trupp 2' }), 'seit')
    expect(lines[0]).toMatchObject({ key: 'as.alarm.tr2', change: 'erledigt', text: 'Trupp 2: Alarm aufgehoben.' })
  })
})

const rescue = (id: string, status: string, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'symbol', symbol: 'VKF Rettungen', fields: { Status: status }, ...over })

describe('L3 · Vermisste (tier 0, Menschen)', () => {
  it('counts the Rettungs-Symbole on «vermisst» with their storeys, once per record', () => {
    const r = rescue('p1', 'vermisst', { floor: 3 })
    const f = fact('pers.vermisst', collectFacts(input({ symbols: [r, { ...r }] })))!
    expect(f).toMatchObject({ tier: 0, slot: 'menschen', value: 1 })
    expect(f.text).toBe('1 Person vermisst, 3. OG.')
  })
  it('adds the eingeschlossenen; an unset count is one person', () => {
    const f = fact('pers.vermisst', collectFacts(input({ symbols: [rescue('p1', 'vermisst', { count: 2 }), rescue('p2', 'eingesperrt')] })))!
    expect(f.value).toBe(3)
    expect(f.text).toBe('2 Personen vermisst. 1 Person eingeschlossen.')
  })
  it('found → «Keine weiteren Vermissten» (ERLEDIGT)', () => {
    const { lines } = diffFacts([], anchorRef(5, { 'pers.vermisst': 1 }), 'seit')
    expect(lines[0]).toMatchObject({ change: 'erledigt', text: 'Keine weiteren Vermissten.' })
  })
  it('fewer missing is BESSER, more is SCHLECHTER', () => {
    const f = { key: 'pers.vermisst', rule: 'L3', slot: 'menschen', tier: 0, value: 1, text: '', trend: 'count-worse' } as LageFact
    expect(changeOf(f, 2, true)).toBe('besser')
    expect(changeOf({ ...f, value: 3 }, 2, true)).toBe('schlechter')
  })
})

describe('G1 · Gerettete', () => {
  it('takes the larger of symbols and «Person gerettet» entries, and the hand-over', () => {
    const rows = [row(20, 'Person gerettet'), row(22, 'Patient an Sanität übergeben')]
    const f = fact('pers.gerettet', collectFacts(input({ rows, symbols: [rescue('p1', 'gerettet')] })))!
    expect(f).toMatchObject({ tier: 1, value: 1, trend: 'count-better' })
    expect(f.text).toBe('1 Person gerettet, an Sanität übergeben.')
  })
  it('matches the station phrase only — not a sentence that merely contains the words', () => {
    const f = fact('pers.gerettet', collectFacts(input({ rows: [row(20, 'Ist eine Person gerettet worden?')] })))
    expect(f).toBeUndefined()
  })
  it('a tagged entry counts: «Sofortmassnahme · Person gerettet aus 3. OG»', () => {
    const f = fact('pers.gerettet', collectFacts(input({ rows: [row(20, 'Sofortmassnahme · Person gerettet aus 3. OG', { entryType: 'sofort' })] })))
    expect(f?.value).toBe(1)
  })
})

describe('G2 · Gebäude geräumt', () => {
  it('is a state once said', () => {
    const facts = collectFacts(input({ rows: [row(15, 'Gebäude geräumt'), row(16, 'Keine Personen im Gebäude')] }))
    expect(fact('pers.geraeumt', facts)?.text).toBe('Gebäude geräumt.')
    expect(fact('pers.keine', facts)?.text).toBe('Keine Personen im Gebäude.')
  })
})

describe('G3 / G4 · Gefahren on the map', () => {
  it('a placard with a UN number names the substance and the ERG isolation distance', () => {
    __setErgData({ version: 't', un: { 1005: { g: 125, tih: [{ si: '30 m', pd: '0.1 km', pn: '0.2 km' }] } } })
    const placard = { id: 'g1', kind: 'symbol', symbol: 'FW Gefahr Tafel', fields: { 'UN-Nr.': '1005', Stoff: 'Ammoniak' } }
    const f = fact('hz.un.1005', collectFacts(input({ symbols: [placard] })))!
    expect(f).toMatchObject({ rule: 'G3', tier: 1, slot: 'gefahren' })
    expect(f.text).toBe('Gefahrstoff UN 1005 Ammoniak, Absperrung 30 m.')
  })
  it('another hazard sign, with its storey; marked erledigt it is gone → ERLEDIGT', () => {
    const ex = { id: 'x1', kind: 'symbol', symbol: 'FW Gefahr Ex', floor: 0 }
    const f = fact('hz.sym.x1', collectFacts(input({ symbols: [ex] })))!
    expect(f.text).toBe('Explosion, EG.')
    const done = { ...ex, done: { at: at(30) } }
    const facts = collectFacts(input({ symbols: [done] }))
    expect(fact('hz.sym.x1', facts)).toBeUndefined()
    const { lines } = diffFacts(facts, anchorRef(25, { 'hz.sym.x1': 'Explosion' }), 'seit')
    expect(line('hz.sym.x1', lines)).toMatchObject({ change: 'erledigt', text: 'Explosion: erledigt.' })
  })
  it('a vehicle or a non-hazard symbol is not a Gefahr', () => {
    const facts = collectFacts(input({ symbols: [{ id: 'v', kind: 'vehicle', symbol: 'FW Gefahr Ex' }, { id: 'h', kind: 'symbol', symbol: 'VKF Hydrant' }] }))
    expect(facts.filter((f) => f.slot === 'gefahren')).toEqual([])
  })
})

const building = (over: Partial<BuildingInfo> = {}): BuildingInfo => ({
  registers: 'on', egid: '1', address: 'Hauptstrasse 12', gwr_status: 'ok', pv_status: 'ok', registers_fetched_at: null, object: null, visit: null,
  gwr: { heating: ['gas'], hot_water: [], floors: 4 } as unknown as BuildingInfo['gwr'],
  plants: [{ kind: 'pv', power_kw: 12 } as unknown as BuildingInfo['plants'][number]],
  ...over,
})

describe('G5 · the building (F5 registers)', () => {
  it('gas, PV and more than three storeys — tagged «Register»', () => {
    const facts = collectFacts(input({ building: building() }))
    expect(fact('hz.gas', facts)).toMatchObject({ text: 'Gasheizung im Gebäude.', tag: 'register' })
    expect(fact('hz.pv', facts)).toMatchObject({ text: 'PV-Anlage auf dem Dach.', tag: 'register' })
    expect(fact('lage.geschosse', facts)).toMatchObject({ slot: 'lage', text: '4 Geschosse.' })
  })
  it('«Gas abgestellt» turns the hazard BESSER', () => {
    const facts = collectFacts(input({ building: building(), rows: [row(20, 'Gas abgestellt')] }))
    const gas = fact('hz.gas', facts)!
    expect(gas).toMatchObject({ value: 'ab', text: 'Gas abgestellt.' })
    expect(changeOf(gas, 'present', true)).toBe('besser')
  })
  it('a failed or skipped register says nothing', () => {
    expect(collectFacts(input({ building: building({ gwr_status: 'error', pv_status: 'skipped' }) })).filter((f) => f.rule === 'G5')).toEqual([])
  })
})

describe('G6 · wind shift', () => {
  const shift = (min: number) => row(min, 'Wind dreht: W → NO (286° → 66°) · Lüfter prüfen', { id: `wxd-${min}`, icon: 'wind', kind: undefined })
  it('only a shift after the anchor; context unless something is in the air', () => {
    const f = fact('wind.shift', collectFacts(input({ rows: [shift(20)] }), anchorRef(5, {})))!
    expect(f).toMatchObject({ tier: 2, event: true, text: 'Wind gedreht auf Nordost.' })
    expect(fact('wind.shift', collectFacts(input({ rows: [shift(4)] }), anchorRef(5, {})))).toBeUndefined()
  })
  it('beside a hazard or a Lüfter it is Lage-ändernd (tier 1)', () => {
    const lf = { id: 'l', kind: 'symbol', symbol: 'VKF Luefter mobil' }
    expect(fact('wind.shift', collectFacts(input({ rows: [shift(20)], symbols: [lf] })))?.tier).toBe(1)
    expect(fact('wind.shift', collectFacts(input({ rows: [shift(20), row(10, 'Entrauchung eingeleitet')] })))?.tier).toBe(1)
  })
})

describe('G7 · milestones', () => {
  it('«Feuer aus» supersedes «unter Kontrolle» and reads BESSER against it', () => {
    const rows = [row(45, 'Brand unter Kontrolle'), row(52, 'Feuer aus'), row(53, 'Nachlöscharbeiten laufen')]
    const draft = composeLagemeldung(input({ now: T0 + 60 * 60_000, rows }), { mode: 'seit', anchor: anchorRef(40, { 'lage.stand': 'kontrolle' }) })
    const l = line('lage.stand', draft.lines)!
    expect(l).toMatchObject({ change: 'besser', text: `Feuer aus ${clk(52)}, Nachlöscharbeiten laufen.` })
    expect(draft.windDown).toBe(true)
    expect(draft.hidden.find((h) => h.reason === 'superseded')).toMatchObject({ text: 'Brand unter Kontrolle', detail: 'Feuer aus' })
  })
  it('already said and unchanged → hidden', () => {
    const draft = composeLagemeldung(input({ rows: [row(45, 'Brand unter Kontrolle')] }), { mode: 'seit', anchor: anchorRef(46, { 'lage.stand': 'kontrolle' }) })
    expect(line('lage.stand', draft.lines)).toBeUndefined()
    expect(draft.hidden.find((h) => h.key === 'lage.stand')).toMatchObject({ reason: 'gleich', detail: clk(46) })
  })
})

describe('G8 · Bedarf, K4 · Ablösung absehbar', () => {
  const pendenz = (over: Partial<OpenReminder> = {}): OpenReminder => ({ id: 'p1', rowId: 'r', text: 'Hubretter anfordern', createdAt: at(10), notes: [], urgent: true, ...over })
  it('an urgent Pendenz is Bedarf; a timed or ordinary one is not', () => {
    const facts = collectFacts(input({ reminders: [pendenz(), pendenz({ id: 'p2', urgent: false }), pendenz({ id: 'p3', dueAt: at(30) })] }))
    expect(facts.filter((f) => f.slot === 'bedarf' && !f.offer).map((f) => f.text)).toEqual(['Hubretter anfordern.'])
  })
  it('«Verstärkung angefordert» stays open until something arrives after it', () => {
    const rows = [row(10, 'Verstärkung angefordert')]
    expect(fact('bedarf.verstaerkung', collectFacts(input({ rows })))?.tier).toBe(1)
    const arrived = collectFacts(input({ rows, fahrzeuge: [{ id: 'adl', vorOrt: at(18) }] }))
    expect(fact('bedarf.verstaerkung', arrived)).toBeUndefined()
  })
  it('a Trupp in Rückzug with no relief angemeldet → «Atemschutz-Ablösung jetzt»', () => {
    const facts = collectFacts(input({ now: T0 + 20 * 60_000, trupps: [trupp({ status: 'rueckzug', lastContactTime: at(19) })] }))
    expect(fact('bedarf.as', facts)?.text).toBe('Atemschutz-Ablösung jetzt.')
    const relief = collectFacts(input({ now: T0 + 20 * 60_000, trupps: [trupp({ status: 'rueckzug', lastContactTime: at(19) }), trupp({ id: 'tr9', status: 'angemeldet' })] }))
    expect(fact('bedarf.as', relief)).toBeUndefined()
  })
  it('a Trupp at its Alarmdruck needs its relief now; the Sicherheitstrupp is nobody\'s relief', () => {
    const t = trupp({ lastPressureBar: 55, lastPressureTime: at(19), lastContactTime: at(19) })
    const sitr = trupp({ id: 'tr9', no: 9, status: 'angemeldet', auftrag: 'sichern' })
    expect(fact('bedarf.as', collectFacts(input({ now: T0 + 20 * 60_000, trupps: [t, sitr] })))?.tier).toBe(1)
  })
  it('foreseen from the pressure history — a Schätzung, never more than context', () => {
    const t = trupp({
      entryPressureBar: 300, entryTime: at(0), lastContactTime: at(19),
      readings: [{ kind: 'pressure', t: at(10), bar: 200 }, { kind: 'pressure', t: at(19), bar: 110 }] as Trupp['readings'],
      lastPressureBar: 110, lastPressureTime: at(19),
    })
    const f = fact('bedarf.as.bald', collectFacts(input({ now: T0 + 20 * 60_000, trupps: [t] })))!
    expect(f).toMatchObject({ rule: 'K4', tier: 2, tag: 'schaetzung' })
    expect(f.text).toMatch(/^Atemschutz-Ablösung in ca\. \d+′\.$/)
  })
  it('every need met → one «keiner mehr» line', () => {
    const { lines } = diffFacts([], anchorRef(25, { 'bedarf.as': 'Atemschutz-Ablösung jetzt.', 'bedarf.p.p1': 'Hubretter anfordern' }), 'seit')
    expect(lines.filter((l) => l.slot === 'bedarf').map((l) => [l.text, l.change])).toEqual([['keiner mehr.', 'erledigt']])
  })
  it('one need met, another still open → that one ERLEDIGT', () => {
    const facts = collectFacts(input({ reminders: [pendenz()] }))
    const { lines } = diffFacts(facts, anchorRef(25, { 'bedarf.p.p1': 'Hubretter anfordern', 'bedarf.verstaerkung': 'Verstärkung angefordert, noch nicht vor Ort.' }), 'seit')
    expect(line('bedarf.verstaerkung', lines)).toMatchObject({ change: 'erledigt', text: 'Verstärkung angefordert, noch nicht vor Ort: erledigt.' })
  })
})

describe('K1 · Lage core', () => {
  it('the Stichwort and the damage with its storeys — never the dispatch text (S4)', () => {
    const fire = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2 }
    const smoke = { id: 's1', kind: 'symbol', symbol: 'VKF Rauch', floorFrom: 1, floorTo: 3 }
    const f = fact('lage.kern', collectFacts(input({ symbols: [fire, smoke], alarmText: 'Rauch aus Fenster, Personen evtl. im Gebäude' })))!
    expect(f.text).toBe('Brand MFH. Feuer 2. OG, Rauch 1. OG–3. OG.')
    expect(f.text).not.toContain('Fenster')
  })
  it('every fire marked gelöscht → «Feuer gelöscht HH:MM», BESSER', () => {
    const fire = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2, done: { at: at(52) } }
    const f = fact('lage.kern', collectFacts(input({ symbols: [fire] })))!
    expect(f.text).toBe(`Brand MFH. Feuer gelöscht ${clk(52)}.`)
    expect(changeOf(f, ['Brand MFH', 'Feuer 2. OG'], true)).toBe('neu')
  })
  it('once «Feuer aus» was said, the marked symbol is not said a second time', () => {
    const fire = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2, done: { at: at(52) } }
    const f = fact('lage.kern', collectFacts(input({ symbols: [fire], rows: [row(52, 'Feuer aus')] })))!
    expect(f.text).toBe('Brand MFH.')
  })
  it('spreading is SCHLECHTER', () => {
    const one = fact('lage.kern', collectFacts(input({ symbols: [{ id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2 }] })))!
    const two = fact('lage.kern', collectFacts(input({ symbols: [{ id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2 }, { id: 'f2', kind: 'symbol', symbol: 'VKF Feuer', floor: 3 }] })))!
    expect(changeOf(two, one.value, true)).toBe('schlechter')
    expect(changeOf(one, two.value, true)).toBe('besser')
  })
})

describe('K2 · Massnahmen', () => {
  it('Trupps by Auftrag and Ziel, the Sicherheitstrupp, measures from the phrases', () => {
    const trupps = [trupp({}), trupp({ id: 'tr2', no: 2, auftrag: 'loeschen', ziel: '2. OG' }), trupp({ id: 'tr3', no: 3, auftrag: 'sichern', ziel: '' })]
    const facts = collectFacts(input({ now: T0 + 9 * 60_000, trupps, rows: [row(8, 'Entrauchung eingeleitet')] }))
    expect(fact('mass.trupps', facts)?.text).toBe('2 Trupps im Einsatz: Retten 3. OG, Löschen 2. OG. Sicherheitstrupp bereit.')
    expect(fact('mass.trupps', facts)?.short).toBe('2 Trupps im Einsatz. Sicherheitstrupp bereit.')
    expect(fact('mass.entrauchung', facts)?.text).toBe('Entrauchung eingeleitet.')
  })
  it('a Trupp angemeldet for a job waits at the entry: «Bereit: …»', () => {
    const f = fact('mass.trupps', collectFacts(input({ trupps: [trupp({ status: 'angemeldet', entryTime: '', lastContactTime: '' })] })))!
    expect(f.text).toBe('Bereit: Retten 3. OG.')
  })
  it('a relief crew on the same job is not news', () => {
    const a = fact('mass.trupps', collectFacts(input({ now: T0 + 9 * 60_000, trupps: [trupp({})] })))!
    const b = fact('mass.trupps', collectFacts(input({ now: T0 + 9 * 60_000, trupps: [trupp({ id: 'tr7', no: 7 })] })))!
    expect(changeOf(b, a.value, true)).toBe('gleich')
  })
  it('all Trupps out after some were in → «Atemschutz beendet»', () => {
    const out = trupp({ status: 'raus', exitTime: at(50) })
    const f = fact('mass.trupps', collectFacts(input({ trupps: [out] }), anchorRef(40, { 'mass.trupps': ['job|Retten 3. OG'] })))!
    expect(f.text).toBe('Atemschutz beendet, alle Trupps draussen.')
  })
  it('«Atemschutz eingesetzt» is the Trupps line\'s to say — also once they are all out', () => {
    const facts = collectFacts(input({ trupps: [trupp({ status: 'raus', exitTime: at(50) })], rows: [row(8, 'Atemschutz eingesetzt')] }))
    expect(fact('mass.atemschutz', facts)).toBeUndefined()
  })
  it('«Rekognoszierung läuft» is over once «Erkundung abgeschlossen» follows', () => {
    const facts = collectFacts(input({ rows: [row(2, 'Rekognoszierung läuft'), row(6, 'Erkundung abgeschlossen')] }))
    expect(fact('mass.rekognoszierung', facts)).toBeUndefined()
    expect(fact('mass.erkundungFertig', facts)).toBeDefined()
  })
})

describe('K3 · Mittel', () => {
  it('first report: on scene and coming', () => {
    const f = fact('mittel.vorOrt', collectFacts(input({ fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }, { id: 'adl', ausgerueckt: at(3) }] })))!
    expect(f.text).toBe('TLF vor Ort, ADL anrückend.')
    expect(f.value).toEqual(['TLF', '~ADL'])
  })
  it('since the anchor: what arrived and what left; partners from the map and the phrases', () => {
    const fahrzeuge = [{ id: 'tlf', vorOrt: at(4) }, { id: 'adl', vorOrt: at(9), gps: { zone: 'away' as const } }, { id: 'mtf', vorOrt: at(20) }]
    const symbols = [{ id: 'b1', kind: 'symbol', symbol: 'VKF Bereich Polizei' }]
    const f = fact('mittel.vorOrt', collectFacts(input({ fahrzeuge, symbols, rows: [row(15, 'Sanität vor Ort')] }), anchorRef(5, { 'mittel.vorOrt': ['ADL', 'TLF'] })))!
    expect(f.text).toBe('neu MTF, Polizei, Sanität; ADL eingerückt.')
    expect(f.short).toBe('3 Fahrzeuge neu.')
  })
  it('the AdF count only when it moved by three or more', () => {
    expect(fact('mittel.adf', collectFacts(input({ present: 8 }), anchorRef(5, { 'mittel.adf': 6 })))?.value).toBe(6)
    expect(fact('mittel.adf', collectFacts(input({ present: 14 }), anchorRef(5, { 'mittel.adf': 6 })))?.text).toBe('14 AdF.')
  })
  it('a Nachalarm the server attached after the anchor', () => {
    const r = row(20, 'Alarm hinzugefügt (21:31): Gruppe Grün — Wasserversorgung · Hauptstrasse 12', { id: 'sys-1', kind: undefined })
    const f = fact('mittel.nachalarm.sys-1', collectFacts(input({ rows: [r] }), anchorRef(5, {})))!
    expect(f).toMatchObject({ event: true, text: 'Nachalarm Gruppe Grün.' })
  })
})

describe('K5 · Nächste Meldung', () => {
  it('a time, the handover, or nothing planned', () => {
    expect(fact('naechste', collectFacts(input({ next: T0 + 25 * 60_000 })))?.text).toBe(`Nächste Meldung ca. ${clk(25)}.`)
    expect(fact('naechste', collectFacts(input({ next: 'handover' })))?.text).toBe('Nächste Meldung bei Übergabe.')
    expect(fact('naechste', collectFacts(input({ next: null })))?.text).toBe('Keine weitere Lagemeldung geplant.')
    expect(fact('naechste', collectFacts(input()))).toBeUndefined()
  })
})

describe('H1 / H2 · Hintergrund (offered, never pre-ticked)', () => {
  it('own Aufträge since the anchor that no rule read', () => {
    const rows = [row(10, 'Auftrag · Gruppe Grün Wasserversorgung ab H-14', { entryType: 'auftrag' }), row(11, 'Auftrag · Entrauchung eingeleitet', { entryType: 'auftrag' }), row(3, 'Auftrag · alt', { entryType: 'auftrag' })]
    const draft = composeLagemeldung(input({ rows }), { mode: 'seit', anchor: anchorRef(5, {}) })
    const offers = draft.hidden.filter((h) => h.reason === 'offer')
    expect(offers.map((h) => h.text)).toEqual(['Auftrag · Gruppe Grün Wasserversorgung ab H-14.'])
    expect(draft.lines.some((l) => l.rule === 'H1')).toBe(false)
  })
  it('Erinnerungen due within ten minutes, not the Lagemeldung\'s own booking', () => {
    const reminders: OpenReminder[] = [
      { id: 'e1', rowId: 'r', text: 'Ablösung einteilen', dueAt: at(28), createdAt: at(10), notes: [] },
      { id: 'e2', rowId: 'r', text: 'Später', dueAt: at(60), createdAt: at(10), notes: [] },
      { id: 'lgm-x', rowId: 'r', text: 'Lagemeldung', dueAt: at(26), createdAt: at(10), notes: [], purpose: 'lagemeldung' },
    ]
    const offers = composeLagemeldung(input({ now: T0 + 25 * 60_000, reminders }), { mode: 'seit', anchor: null }).hidden.filter((h) => h.reason === 'offer')
    expect(offers.map((h) => h.text)).toEqual([`Ablösung einteilen (${clk(28)}).`])
  })
})

describe('diff · the tags', () => {
  const f = (over: Partial<LageFact>): LageFact => ({ key: 'k', rule: 'K1', slot: 'lage', tier: 2, value: 'a', text: 'x.', ...over })
  it('no anchor: everything is NEU (Erstmeldung)', () => {
    expect(changeOf(f({}), undefined, false)).toBe('neu')
  })
  it('missing key NEU · same value = · changed value without order NEU · events always NEU', () => {
    expect(changeOf(f({}), undefined, true)).toBe('neu')
    expect(changeOf(f({}), 'a', true)).toBe('gleich')
    expect(changeOf(f({ value: ['x', 'y'] }), ['x', 'y'], true)).toBe('gleich')
    expect(changeOf(f({}), 'b', true)).toBe('neu')
    expect(changeOf(f({ event: true }), 'a', true)).toBe('neu')
  })
  it('unchanged T1/T2 is hidden «seit», shown «vollständig»; T0 is repeated either way', () => {
    const facts = [f({ key: 'a', tier: 2 }), f({ key: 'b', tier: 0, slot: 'zuerst' })]
    const seit = diffFacts(facts, anchorRef(5, { a: 'a', b: 'a' }), 'seit')
    expect(seit.lines.map((l) => [l.key, l.change])).toEqual([['b', 'gleich']])
    expect(seit.hidden).toMatchObject([{ key: 'a', reason: 'gleich', detail: clk(5) }])
    const voll = diffFacts(facts, anchorRef(5, { a: 'a', b: 'a' }), 'voll')
    expect(voll.lines.map((l) => l.key)).toEqual(['b', 'a'])
  })
  it('a declined fact stays quiet while unchanged — even «vollständig» — but tier 0 comes back', () => {
    const facts = [f({ key: 'a' }), f({ key: 'b', tier: 0, slot: 'zuerst' })]
    const anchor = anchorRef(5, { a: 'a', b: 'a' }, ['a', 'b'])
    const voll = diffFacts(facts, anchor, 'voll')
    expect(voll.lines.map((l) => l.key)).toEqual(['b'])
    expect(voll.hidden).toMatchObject([{ key: 'a', reason: 'declined' }])
    expect(diffFacts([f({ key: 'a', value: 'changed' })], anchor, 'seit').lines.map((l) => l.change)).toEqual(['neu'])
  })
  it('a declined fact that disappears is not announced as ERLEDIGT — it was never said', () => {
    expect(diffFacts([], anchorRef(5, { 'pers.vermisst': 1 }, ['pers.vermisst']), 'seit').lines).toEqual([])
  })
  it('lines are printed in slot order, whatever the score', () => {
    const { lines } = diffFacts([f({ key: 'm', slot: 'mittel' }), f({ key: 'z', slot: 'zuerst', tier: 0 }), f({ key: 'l', slot: 'lage' })], null, 'seit')
    expect(lines.map((l) => l.slot)).toEqual(['zuerst', 'lage', 'mittel'])
  })
})

describe('budget · fit the radio', () => {
  const words = (n: number, w = 'wort') => `${Array.from({ length: n }, () => w).join(' ')}.`
  const l = (key: string, tier: 0 | 1 | 2, n: number, over: Partial<LageLine> = {}): LageLine =>
    ({ key, rule: 'K1', slot: 'lage', tier, change: 'neu', score: [100, 60, 30][tier] + 20, text: words(n), full: words(n), ...over })
  it('under the budget nothing changes', () => {
    const r = fitBudget([l('a', 2, 10)], 60)
    expect(r.lines[0].shortened).toBeUndefined()
    expect(r.hidden).toEqual([])
  })
  it('T2 switches to its short form first, lowest score first', () => {
    const r = fitBudget([l('a', 2, 40, { short: 'kurz.', score: 50 }), l('b', 2, 30, { short: 'auch kurz.', score: 40, slot: 'mittel' })], 60)
    expect(r.lines.find((x) => x.key === 'b')).toMatchObject({ shortened: true, text: 'auch kurz.' })
    expect(r.lines.find((x) => x.key === 'a')?.shortened).toBeUndefined()
    expect(r.hidden).toEqual([])
  })
  it('then the lowest score drops into «über Funklänge», full text kept for adding back', () => {
    const r = fitBudget([l('a', 1, 40, { slot: 'gefahren' }), l('b', 2, 30, { slot: 'mittel' })], 60)
    expect(r.lines.map((x) => x.key)).toEqual(['a'])
    expect(r.hidden).toMatchObject([{ key: 'b', reason: 'budget' }])
    expect(r.hidden[0].line?.text).toBe(words(30))
  })
  it('T0 is never cut and never shortened — even alone over the budget', () => {
    const r = fitBudget([l('z', 0, 80, { slot: 'zuerst', short: 'x.' }), l('b', 1, 10, { slot: 'mittel' })], 60)
    expect(r.lines.map((x) => [x.key, x.text])).toEqual([['z', words(80)]])
  })
  it('«Nächste» always stays', () => {
    const r = fitBudget([l('n', 2, 4, { slot: 'naechste', score: 0 }), l('a', 1, 70)], 60)
    expect(r.lines.map((x) => x.key).sort()).toEqual(['n'])
  })
  it('T1 is never shortened', () => {
    const r = fitBudget([l('a', 1, 70, { short: 'kurz.' })], 60)
    expect(r.hidden.map((h) => h.key)).toEqual(['a'])
  })
})

describe('radio text, words, seconds', () => {
  it('one sentence group per slot, «Nächste» without its label', () => {
    const lines = [
      { slot: 'gefahren' as const, text: 'Gas abgestellt.' }, { slot: 'gefahren' as const, text: 'Wind gedreht auf Nordost.' },
      { slot: 'zuerst' as const, text: 'Trupp 2 Alarmdruck.' }, { slot: 'naechste' as const, text: 'Nächste Meldung ca. 21:57.' },
    ]
    expect(radioText(lines)).toBe('Zuerst: Trupp 2 Alarmdruck.\nGefahren: Gas abgestellt. Wind gedreht auf Nordost.\nNächste Meldung ca. 21:57.')
  })
  it('counts words and seconds at ≈ 1.8 words a second', () => {
    expect(wordCount('  Lage: Brand 2. OG.\nNächste ')).toBe(5)
    expect(wordCount('')).toBe(0)
    expect(radioSeconds(44)).toBe(24)
  })
})

describe('the EL\'s hand and the stored anchor', () => {
  const draftAt25 = () => {
    const rows = [row(20, 'Gas abgestellt')]
    return composeLagemeldung(input({ now: T0 + 25 * 60_000, rows, building: building(), present: 14, next: T0 + 45 * 60_000, fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }] }), {
      mode: 'seit', anchor: anchorRef(5, { 'hz.gas': 'present', 'hz.pv': 'present', 'mittel.vorOrt': ['TLF'], 'mittel.adf': 6, 'lage.kern': ['Brand MFH'], 'lage.geschosse': 4 }),
    })
  }
  it('ticks, edits, added hidden items and own lines make the final text', () => {
    const d = draftAt25()
    const lines = finalLines(d, { ticked: { 'mittel.adf': false }, text: { 'hz.gas': 'Gas am Hauptschieber abgestellt.' }, added: ['hz.pv'], own: ['Presse vor Ort'] })
    const said = lines.filter((x) => x.ticked)
    expect(radioText(said)).toBe('Gefahren: Gas am Hauptschieber abgestellt. PV-Anlage auf dem Dach.\nZusatz: Presse vor Ort.\n' + `Nächste Meldung ca. ${clk(45)}.`)
  })
  it('stores what was said, carries the unchanged forward, marks the declined — never the budget-cut or events', () => {
    const d = draftAt25()
    const a = anchorFor(d, { ticked: { 'mittel.adf': false } }, anchorRef(5, { 'hz.gas': 'present', 'hz.pv': 'present', 'mittel.vorOrt': ['TLF'], 'mittel.adf': 6, 'lage.kern': ['Brand MFH'] }))
    expect(a.facts['hz.gas']).toBe('ab')
    expect(a.facts['hz.pv']).toBe('present') // unchanged → carried
    expect(a.facts['mittel.adf']).toBe(14)
    expect(a.declined).toEqual(['mittel.adf'])
    expect(a.facts.naechste).toBeUndefined()
  })
  it('the summary the due row shows', () => {
    expect(changeSummary(draftAt25())).toEqual({ changes: 2, urgent: 0 })
  })
})

// ── the three moments of the design (f3.html §02), end to end ──────────────────────────────────

describe('one Einsatz, three Lagemeldungen', () => {
  const fire = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2 }
  const smoke = { id: 's1', kind: 'symbol', symbol: 'VKF Rauch', floorFrom: 1, floorTo: 3 }
  const missing = rescue('p1', 'vermisst', { floor: 3 })

  it('minute 5 — Erstmeldung: everything new, the dispatch named but not said', () => {
    const d = composeLagemeldung(input({
      now: T0 + 5 * 60_000, symbols: [fire, smoke, missing], building: building(), alarmText: 'Rauch aus Fenster',
      fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }, { id: 'adl', ausgerueckt: at(3) }], present: 6, next: T0 + 25 * 60_000,
      rows: [row(4, 'Einsatzleitung übernommen'), row(5, 'Rekognoszierung läuft')],
    }), { mode: 'seit', anchor: null })
    expect(d.first).toBe(true)
    const text = radioText(d.lines)
    expect(text).toBe([
      'Lage: Brand MFH. Feuer 2. OG, Rauch 1. OG–3. OG. 4 Geschosse.',
      'Menschen: 1 Person vermisst, 3. OG.',
      'Gefahren: Gasheizung im Gebäude. PV-Anlage auf dem Dach.',
      'Massnahmen: Rekognoszierung läuft.',
      'Mittel: TLF vor Ort, ADL anrückend. 6 AdF.',
      `Nächste Meldung ca. ${clk(25)}.`,
    ].join('\n'))
    expect(wordCount(text)).toBeLessThanOrEqual(60)
    expect(d.lines.every((l) => l.change === 'neu')).toBe(true)
    expect(d.hidden.map((h) => h.reason)).toEqual(expect.arrayContaining(['dispatch', 'routine']))
  })

  it('minute 25 — delta: Alarmdruck first, the rest only what changed', () => {
    const prev = anchorRef(5, {
      'lage.kern': ['Brand MFH', 'Feuer 2. OG', 'Rauch 1. OG–3. OG'], 'lage.geschosse': 4, 'pers.vermisst': 1, 'hz.gas': 'present', 'hz.pv': 'present',
      'mass.rekognoszierung': 'ja', 'mittel.vorOrt': ['TLF', '~ADL'], 'mittel.adf': 6,
    })
    const d = composeLagemeldung(input({
      now: T0 + 25 * 60_000,
      symbols: [fire, smoke, rescue('p1', 'gerettet', { floor: 3 })], building: building(),
      trupps: [
        trupp({ id: 'tr1', no: 1, status: 'raus', exitTime: at(22) }),
        trupp({ id: 'tr2', no: 2, auftrag: 'loeschen', ziel: '2. OG', lastPressureBar: 55, lastPressureTime: at(24), lastContactTime: at(24), entryTime: at(10) }),
        trupp({ id: 'tr3', no: 3, auftrag: 'sichern', ziel: '', status: 'angemeldet' }),
      ],
      fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }, { id: 'adl', vorOrt: at(9) }, { id: 'mtf', vorOrt: at(18) }],
      present: 14, next: T0 + 45 * 60_000,
      rows: [
        row(5, 'Rekognoszierung läuft'), row(12, 'Person gerettet'), row(14, 'Patient an Sanität übergeben'),
        row(15, 'Gas abgestellt'), row(16, 'Sanität vor Ort'), row(17, 'Entrauchung eingeleitet'),
        row(20, 'Wind dreht: W → NO (286° → 66°) · Lüfter prüfen', { id: 'wxd-20', kind: undefined }),
        ...Array.from({ length: 7 }, (_, i) => row(10 + i, 'Symbol', { kind: 'symbol' })),
      ],
    }), { mode: 'seit', anchor: prev })
    const zuerst = d.lines[0]
    expect(zuerst).toMatchObject({ slot: 'zuerst', tier: 0, change: 'neu' })
    expect(zuerst.text).toContain('Trupp 2 Alarmdruck')
    const tags = Object.fromEntries(d.lines.map((l) => [l.key, l.change]))
    expect(tags['pers.vermisst']).toBe('erledigt')
    expect(tags['pers.gerettet']).toBe('neu')
    expect(tags['hz.gas']).toBe('besser')
    expect(tags['wind.shift']).toBe('neu')
    expect(tags['mittel.vorOrt']).toBe('neu')
    expect(line('mittel.vorOrt', d.lines)?.text).toBe('neu ADL, MTF, Sanität.')
    expect(tags['lage.kern']).toBeUndefined() // unchanged → hidden
    expect(d.hidden.find((h) => h.key === 'lage.kern')?.reason).toBe('gleich')
    expect(d.hidden.find((h) => h.key === 'routine.symbols')?.text).toBe('7 Symbol-Einträge')
    expect(wordCount(radioText(d.lines))).toBeLessThanOrEqual(60)
  })

  it('minute 60 — winding down: shorter on its own, the rhythm offers to stretch', () => {
    const prev = anchorRef(45, {
      'lage.kern': ['Brand MFH', 'Feuer 2. OG', 'Rauch 1. OG–3. OG'], 'lage.stand': 'kontrolle', 'pers.gerettet': 1, 'hz.gas': 'ab', 'hz.pv': 'present',
      'mass.trupps': ['job|Löschen 2. OG', 'sitr'], 'mittel.vorOrt': ['ADL', 'MTF', 'Sanität', 'TLF'], 'mittel.adf': 14, 'bedarf.as': 'Atemschutz-Ablösung jetzt.',
    })
    const d = composeLagemeldung(input({
      now: T0 + 60 * 60_000,
      symbols: [{ ...fire, done: { at: at(52) } }, rescue('p1', 'gerettet')], building: building(),
      trupps: [trupp({ id: 'tr2', no: 2, status: 'raus', exitTime: at(50) })],
      fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }, { id: 'adl', vorOrt: at(9), zurueck: at(55) }, { id: 'mtf', vorOrt: at(18) }],
      present: 9, next: 'handover',
      rows: [row(12, 'Person gerettet'), row(15, 'Gas abgestellt'), row(16, 'Sanität vor Ort'), row(44, 'Brand unter Kontrolle'), row(52, 'Feuer aus'), row(53, 'Nachlöscharbeiten laufen'), row(56, 'Brandwache gestellt')],
    }), { mode: 'seit', anchor: prev })
    expect(d.windDown).toBe(true)
    const tags = Object.fromEntries(d.lines.map((l) => [l.key, l.change]))
    expect(tags['lage.stand']).toBe('besser')
    expect(tags['mass.trupps']).toBe('neu')
    expect(line('mass.trupps', d.lines)?.text).toBe('Atemschutz beendet, alle Trupps draussen.')
    expect(tags['bedarf.none']).toBe('erledigt')
    expect(line('mittel.vorOrt', d.lines)?.text).toBe('ADL eingerückt.')
    expect(tags['hz.gas']).toBeUndefined()
    expect(radioText(d.lines).split('\n').pop()).toBe('Nächste Meldung bei Übergabe.')
    expect(wordCount(radioText(d.lines))).toBeLessThan(45)
  })

  it('is deterministic: the same record gives the same draft', () => {
    const mk = () => composeLagemeldung(input({ symbols: [fire, missing], present: 6 }), { mode: 'seit', anchor: null })
    expect(mk()).toEqual(mk())
  })
})
