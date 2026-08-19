import { describe, expect, it, vi } from 'vitest'
import type { BoardDoc, Drawing, Entity, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'

// The Zeiten grid is built from the deployment's Gruppen/Fahrzeuge, so the rows have to come
// from a config. Oberwil's shape in miniature: two groups (one with a colour), two vehicles.
const deployment = {
  alarms: { groups: [{ id: 'g1', label: 'Gr. 1', color: 'Rot' }, { id: 'tgp', label: 'Gr. 9' }] },
  fleet: { vehicles: [{ id: 'tlf', label: 'TLF' }, { id: 'pio', label: 'Pio' }] },
}
// `attendanceMergeGapMin` is its own accessor, not a field on the config object — the mock
// has to provide it or personalForPdf/hoursRows blow up on an undefined import
vi.mock('./deploymentConfig', () => ({
  getDeploymentConfig: () => deployment,
  attendanceMergeGapMin: () => 15,
}))
import {
  annotatedPlans,
  changedReportMetaFields,
  einsatzleiterFromScene,
  eventIso,
  hasVisiblePlanAnnotation,
  journalRows,
  pendenzRows,
  metaExtrasForPdf,
  missingTranscriptCount,
  mittelFormForPdf,
  operationalExtentPoints,
  personalForPdf,
  proofLabel,
  readingBarIsMeasured,
  readingKindLabel,
  spanAwareClock,
  truppAuftragLabel,
  truppStatusLabel,
} from './report'

const plans: PlanDocument[] = [
  { id: 'm1', code: 'Modul 1', title: 'Übersicht', subtitle: '', imageUrl: 'm1.pdf', orientation: 'portrait' },
  { id: 'm2', code: 'Modul 2', title: 'Zugang', subtitle: '', imageUrl: 'm2.pdf', orientation: 'landscape' },
]

describe('personalForPdf (Personal-/Soldblatt rows)', () => {
  const roster = [
    { id: 'p1', name: 'Meier Anna' },
    { id: 'p2', name: 'Müller Hans' },
  ]

  it('keeps roster order, ticks recorded people with their clocks, appends guests + blanks', () => {
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T09:05:00' },
      g9: { status: 'left', displayNameSnapshot: 'Gast Vreni', checkedInAt: '2026-06-23T09:00:00', leftAt: '2026-06-23T10:30:00' },
    })
    expect(personal.map((p) => p.name)).toEqual(['Meier Anna', 'Müller Hans', 'Gast Vreni', '', ''])
    expect(personal[0]).toMatchObject({ name: 'Meier Anna', erfasst: true })
    expect(personal[0].times).toEqual([{ von: '09:05', bis: undefined, vonDerived: false, bisDerived: false }])
    expect(personal[1]).toMatchObject({ name: 'Müller Hans', erfasst: false })
    expect(personal[1].times).toEqual([{ von: undefined, bis: undefined, vonDerived: false, bisDerived: false }])
    // …and marked as a guest: on a signed sheet read weeks later by somebody who cannot ask,
    // an unmarked name sitting among our own roster reads as one of ours
    expect(personal[2]).toMatchObject({ name: 'Gast Vreni', erfasst: true, guest: true })
    expect(personal[0].guest).toBeFalsy()
    expect(personal[2].times).toEqual([{ von: '09:00', bis: '10:30', vonDerived: false, bisDerived: false }])
    expect(personal[3].erfasst).toBe(false)
  })

  it('prints the full roster untouched when nothing was recorded (blank form)', () => {
    const { personal } = personalForPdf(roster, {})
    expect(personal).toHaveLength(4) // roster + 2 write-in rows
    expect(personal.every((p) => !p.erfasst)).toBe(true)
  })

  it('gives someone who left and came back one row per block, not an inflated span', () => {
    const { personal } = personalForPdf(roster, {
      p1: {
        status: 'left', displayNameSnapshot: 'Meier Anna',
        checkedInAt: '2026-06-23T09:00:00', leftAt: '2026-06-23T14:00:00',
        intervals: [
          { from: '2026-06-23T09:00:00', to: '2026-06-23T11:00:00' },
          { from: '2026-06-23T13:00:00', to: '2026-06-23T14:00:00' },
        ],
      },
    })
    // one row per PERSON — the two stretches stack in the time column, they do not make two rows
    expect(personal.map((p) => p.name)).toEqual(['Meier Anna', 'Müller Hans', '', ''])
    expect(personal[0]).toMatchObject({ name: 'Meier Anna', erfasst: true })
    expect(personal[0].times?.map((t) => `${t.von}–${t.bis}`)).toEqual(['09:00–11:00', '13:00–14:00'])
  })

  it('fills an open block with the Einsatzende and MARKS it as derived', () => {
    // the printed sheet is what WinFAP reads the hours off, so an open block has to carry a
    // time — but the grey says nobody measured it
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T09:05:00' },
    }, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    expect(personal[0].times).toEqual([{ von: '09:05', bis: '11:30', vonDerived: false, bisDerived: true }])
  })

  it('derives BOTH ends for somebody ticked present with no times at all', () => {
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna' },
    }, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    // a line grey on both ends is one nobody has to check
    expect(personal[0]).toMatchObject({ erfasst: true })
    expect(personal[0].times).toEqual([{ von: '09:00', bis: '11:30', vonDerived: true, bisDerived: true }])
  })

  it('leaves an unrecorded person blank — a derived time must not invent attendance', () => {
    const { personal } = personalForPdf(roster, {}, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    expect(personal[0]).toMatchObject({ erfasst: false })
    expect(personal[0].times).toEqual([{ von: undefined, bis: undefined, vonDerived: false, bisDerived: false }])
  })

  it('carries the DATE once the Einsatz runs past midnight', () => {
    // «08:23 – 09:00» reads as 37 minutes when it was 25 hours
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T08:23:00' },
    }, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-24T09:00:00' })
    expect(personal[0].times?.[0].von).toBe('23.06. 08:23')
    expect(personal[0].times?.[0].bis).toBe('24.06. 09:00')
  })

  // ⚠️ ONE row, two stretches. It used to be one row per BLOCK, so a crew member who left and
  // came back printed their name twice and was counted twice by anyone reading down the roster.
  it('prints a person who came back ONCE, with both stretches', () => {
    const { personal } = personalForPdf(roster, {
      p1: {
        status: 'present', displayNameSnapshot: 'Meier Anna', note: 'Fahrer TLF',
        intervals: [
          { from: '2026-06-23T08:00:00', to: '2026-06-23T09:30:00' },
          { from: '2026-06-23T11:00:00', to: '2026-06-23T12:00:00' },
        ],
      },
    }, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-23T12:00:00' })
    const mine = personal.filter((r) => r.name === 'Meier Anna')
    expect(mine).toHaveLength(1)
    expect(mine[0].times).toHaveLength(2)
    expect(mine[0].times?.map((t) => `${t.von}–${t.bis}`)).toEqual(['08:00–09:30', '11:00–12:00'])
    // the remark belongs to the PERSON, so it is printed once
    expect(mine[0].note).toBe('Fahrer TLF')
  })

  it('prints two ticks a minute apart as ONE stretch', () => {
    // the 08.08. sheet: «22:11 – 22:58» over «22:59 – 23:20» under one name, which reads as
    // somebody who went home during an Einsatz that never stopped
    const { personal } = personalForPdf(roster, {
      p1: {
        status: 'left', displayNameSnapshot: 'Meier Anna',
        intervals: [
          { from: '2026-08-08T22:11:00', to: '2026-08-08T22:58:00' },
          { from: '2026-08-08T22:59:00', to: '2026-08-08T23:20:00' },
        ],
      },
    }, { alarmedAt: '2026-08-08T22:11:00', endedAt: '2026-08-08T23:20:00' })
    expect(personal[0].times?.map((t) => `${t.von}–${t.bis}`)).toEqual(['22:11–23:20'])
  })

  it('stays on bare clocks for an ordinary one-day Einsatz', () => {
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T08:23:00' },
    }, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-23T11:00:00' })
    expect(personal[0].times?.[0].von).toBe('08:23')
  })
})

describe('report plan selection', () => {
  it('counts only visible board annotations', () => {
    const board: BoardDoc = {
      m1: [{ id: 't1', kind: 'text', x: 0.2, y: 0.2, text: 'EL' }],
      m2: [{ id: 't2', kind: 'text', x: 0.2, y: 0.2, text: '   ' }],
    }
    expect(hasVisiblePlanAnnotation(board, 'm1')).toBe(true)
    expect(hasVisiblePlanAnnotation(board, 'm2')).toBe(false)
    expect(annotatedPlans(plans, board, false).map((p) => p.id)).toEqual(['m1'])
    expect(annotatedPlans(plans, board, true).map((p) => p.id)).toEqual(['m1', 'm2'])
  })

  it('treats symbols/resources/drawings as visible annotations', () => {
    const board: BoardDoc = {
      m1: [{ id: 'r1', kind: 'resource', x: 0.4, y: 0.4, text: 'Trupp 1' }],
      m2: [{ id: 'd1', kind: 'draw', x: 0, y: 0, pts: [[0.1, 0.1], [0.2, 0.2]] }],
    }
    expect(annotatedPlans(plans, board, false).map((p) => p.id)).toEqual(['m1', 'm2'])
  })

  it('treats generic shapes (Rauch/Pfeil/Rechteck) as visible annotations', () => {
    const board: BoardDoc = {
      m1: [{ id: 'sh1', kind: 'shape', shape: 'cloud', x: 0.5, y: 0.5, sizeN: 0.18 }],
    }
    expect(hasVisiblePlanAnnotation(board, 'm1')).toBe(true)
  })
})

describe('report journal rows', () => {
  it('sorts chronologically and filters system noise', () => {
    const events: TimelineEvent[] = [
      { id: 'new', t: '10:00', at: '2026-06-23T08:00:00.000Z', icon: 'type', text: 'Nachkontrolle', kind: 'journal' },
      { id: 'move', t: '09:05', at: '2026-06-23T07:05:00.000Z', icon: 'select', text: 'Lüfter verschoben', kind: 'symbol' },
      { id: 'old', t: '09:00', at: '2026-06-23T07:00:00.000Z', icon: 'flag', text: 'Trupp 1 eingerückt', kind: 'team' },
      { id: 'layer', t: '09:01', at: '2026-06-23T07:01:00.000Z', icon: 'layers', text: 'Layer umgeschaltet', kind: 'layer' },
    ]
    const rows = journalRows(events, plans)
    expect(rows.map((r) => r.id)).toEqual(['old', 'new'])
    expect(rows[0].area).toBe('Atemschutz')
    expect(rows[1].area).toBe('Manuell')
  })

  it('names the Bereich each row actually came from', () => {
    const at = (n: number) => `2026-08-08T2${n}:00:00.000Z`
    const events: TimelineEvent[] = [
      // the one that started this: a Rapportangaben change used to print under «Kroki»
      { id: 'meta', t: '22:47', at: at(0), icon: 'clipboard', text: 'Rapportangaben: Einsatzleiter: Meier Anna' },
      // «team» is written by four different surfaces — the icon is what separates them
      { id: 'az', t: '22:31', at: at(1), icon: 'radio', text: 'Funkkontakt Trupp 1', kind: 'team' },
      { id: 'anw', t: '22:11', at: at(2), icon: 'people', text: 'Meier Anna anwesend', kind: 'team' },
      { id: 'mit', t: '22:20', at: at(3), icon: 'box', text: 'Ölbinder: 3 Sack', kind: 'team' },
      // the QR poster writes rows with NO kind at all
      { id: 'qr', t: '22:12', at: at(4), icon: 'user', text: 'Huber Sarah anwesend', surface: 'map' },
      { id: 'check', t: '22:15', at: at(5), icon: 'check', text: '☑ Bereitstellung', kind: 'journal' },
      { id: 'lage', t: '22:18', at: at(6), icon: 'hex', text: 'Symbol "Lüfter" gesetzt', kind: 'symbol' },
    ]
    const byId = new Map(journalRows(events, plans, undefined, null, { includeBookkeeping: true })
      .map((r) => [r.id, r.area]))
    expect(byId.get('meta')).toBe('Rapport')
    expect(byId.get('az')).toBe('Atemschutz')
    expect(byId.get('anw')).toBe('Anwesenheit')
    expect(byId.get('mit')).toBe('Mittel')
    expect(byId.get('qr')).toBe('Anwesenheit')
    expect(byId.get('check')).toBe('Checkliste')
    expect(byId.get('lage')).toBe('Kroki')
  })

  it('drops a prefix the Bereich column already says', () => {
    const e: TimelineEvent = {
      id: 'meta', t: '22:47', at: '2026-08-08T20:47:00.000Z', icon: 'clipboard',
      text: 'Rapportangaben: Einsatzleiter: Meier Anna',
    }
    const row = journalRows([e], plans)[0]
    expect(row.area).toBe('Rapport')
    expect(row.text).toBe('Einsatzleiter: Meier Anna')
  })

  // «Manuell» answers «wo kam das her» — the least interesting thing about an Auftrag, and the
  // word was already sitting in the text as a «Auftrag · » prefix. Column and text swapped jobs.
  it('names the entry type in the Bereich column and drops it from the text', () => {
    const e: TimelineEvent = {
      id: 'a', t: '14:12', at: '2026-08-10T12:12:00.000Z', icon: 'type', kind: 'journal',
      text: 'Auftrag · Trupp 2 sichert das Treppenhaus', entryType: 'auftrag',
    }
    const row = journalRows([e], plans)[0]
    expect(row.area).toBe('Auftrag')
    expect(row.text).toBe('Trupp 2 sichert das Treppenhaus')
  })

  it('leaves an ordinary Info row as «Manuell» — the common case wears no tag anywhere', () => {
    const e: TimelineEvent = {
      id: 'a', t: '14:12', at: '2026-08-10T12:12:00.000Z', icon: 'type', kind: 'journal',
      text: 'Kellerbrand bestätigt', entryType: 'info',
    }
    expect(journalRows([e], plans)[0].area).toBe('Manuell')
  })

  it('uses fallback date for legacy HH:MM rows', () => {
    const e: TimelineEvent = { id: 'a', t: '12:34', icon: 'type', text: 'Alt', kind: 'journal' }
    expect(eventIso(e, '2026-06-23T00:00:00.000Z')).toContain('2026-06-23T')
    expect(journalRows([e], plans, '2026-06-23T00:00:00.000Z')[0].iso).toBeTruthy()
  })

  it('counts missing audio transcripts', () => {
    const events: TimelineEvent[] = [
      { id: 'a', t: '09:00', icon: 'mic', text: 'Audio', kind: 'audio', audioUrl: '/a.wav' },
      { id: 'b', t: '09:01', icon: 'mic', text: 'Audio', kind: 'audio', audioUrl: '/b.wav', transcript: 'Text' },
    ]
    expect(missingTranscriptCount(events)).toBe(1)
  })
})

describe('report proof and Atemschutz labels', () => {
  it('formats proof state', () => {
    expect(proofLabel({ intact: true, count: 2, checkedAt: 'now' })).toBe('Hash-Kette intakt')
    expect(proofLabel({ intact: null, checkedAt: 'now', offline: true })).toContain('offline')
  })

  it('uses rapport status wording', () => {
    const statuses: Trupp['status'][] = ['angemeldet', 'aktiv', 'rueckzug', 'ueberfaellig', 'raus']
    expect(statuses.map(truppStatusLabel)).toEqual(['Angemeldet', 'Im Einsatz', 'Rückzug', 'Überfällig', 'Draussen'])
    expect(readingKindLabel('entry')).toBe('Eintritt')
    expect(readingKindLabel('contact')).toBe('Kontakt')
    expect(readingKindLabel('pressure')).toBe('Druck')
  })

  it('never prints «Draussen» for a Trupp that was stood down without going in', () => {
    const t = (over: Partial<Trupp>): Trupp => ({
      id: 't1', name: 'Meier', entryPressureBar: 300, entryTime: '', lastContactTime: '',
      lowestBar: 300, status: 'raus', readings: [], ...over,
    })
    expect(truppStatusLabel(t({ exitTime: '2026-08-08T22:47:00Z' }))).toBe('Nicht eingesetzt')
    // one that really did come out keeps the word it earned
    expect(truppStatusLabel(t({ entryTime: '2026-08-08T22:20:00Z', exitTime: '2026-08-08T22:47:00Z' }))).toBe('Draussen')
  })

  // ⚠️ A Trupp taken off the Tafel still PRINTS (types · Trupp.removedAt) — and «aktiv» on paper
  // for a crew nobody brought back out is the one thing that page must never say.
  it('says a Trupp was taken off the board, whatever state it was left in', () => {
    const t = (over: Partial<Trupp>): Trupp => ({
      id: 't1', name: 'Meier', entryPressureBar: 300, entryTime: '2026-08-08T22:20:00Z',
      lastContactTime: '2026-08-08T22:30:00Z', lowestBar: 260, status: 'aktiv', readings: [], ...over,
    })
    expect(truppStatusLabel(t({ removedAt: '2026-08-08T22:50:00Z' }))).toBe('Von Tafel entfernt')
    expect(truppStatusLabel(t({}))).toBe('Im Einsatz')
  })
})

describe('server-PDF payload extras', () => {
  it('formats Gerettete and Rückmeldung ELZ, and stays empty when unset', () => {
    const extras = metaExtrasForPdf({
      gerettete: { personen: 2, tiere: 1 },
      rueckmeldungElz: { name: 'Muster Hans', at: '2026-07-18T17:15:00' },
    })
    expect(extras.gerettete).toBe('2 Personen · 1 Tier')
    // the count picks its noun: 1 stays singular, everything else plural
    expect(metaExtrasForPdf({ gerettete: { personen: 1 } }).gerettete).toBe('1 Person')
    expect(extras.rueckmeldungElz).toBe('Muster Hans · 17:15')
    const empty = metaExtrasForPdf({})
    expect(empty.gerettete).toBeUndefined()
    expect(empty.rueckmeldungElz).toBeUndefined()
  })

  // 31.07.2026: a fully automatic alarm (both groups and both vehicles delivered by the
  // milestone integration) printed a rapport with NO Alarm-/Ausrückzeiten at all — the old
  // rule dropped the whole section as soon as anything had been recorded digitally. The
  // grid must always print: recorded values as times, the rest as stubs for the pen.
  it('prints the Zeiten grid whether or not the times were recorded digitally', () => {
    // Timezone-naive stamps on purpose: they parse as LOCAL time, so the expected clocks
    // hold on a CEST laptop and a UTC CI runner alike (same trick as the ELZ test above).
    const recorded = metaExtrasForPdf({
      gruppen: [
        { id: 'g1', alarmedAt: '2026-07-31T12:39:40' },
        { id: 'tgp', alarmedAt: '2026-07-31T12:40:48' },
      ],
      fahrzeuge: [
        { id: 'tlf', ausgerueckt: '2026-07-31T12:43:46', vorOrt: '2026-07-31T12:44:03' },
        // Pio was alarmed but its Ausrückzeit never arrived — a stub, not a missing row.
        { id: 'pio', vorOrt: '2026-07-31T12:46:29' },
      ],
    })
    expect(recorded.zeiten).toEqual([
      ['Gr. 1 (Rot)', '12:39'],
      ['Gr. 9', '12:40'],
      ['TLF', '12:43'],
      ['Pio', ''],
    ])

    // Nothing recorded: the same rows, all stubs — the paper is then the capture medium.
    expect(metaExtrasForPdf({}).zeiten).toEqual([
      ['Gr. 1 (Rot)', ''], ['Gr. 9', ''], ['TLF', ''], ['Pio', ''],
    ])
  })

  it('builds the Material worksheet: full catalogue with stubs, recorded amounts filled', () => {
    const catalogue = [
      { id: 'oel', label: 'Ölbinder', unit: 'Sack' },
      { id: 'sand', label: 'Sandsäcke' },
    ]
    const mittel: MittelEntry[] = [
      { id: 'm1', materialId: 'oel', label: 'Ölbinder', unit: 'Sack', menge: 3, at: '2026-07-14T10:00:00Z', sourceLabel: 'TLF' },
      { id: 'm2', label: 'Spezialschaum', unit: 'l', menge: 20, at: '2026-07-14T10:05:00Z' },
    ]
    const { mittelForm } = mittelFormForPdf(mittel, catalogue)
    expect(mittelForm).toEqual([
      { label: 'Ölbinder', menge: '3', unit: 'Sack' },
      // a catalogue entry with no unit of its own is counted in «Stk.» — WITH the dot, the
      // one spelling (appConfig.mittel.defaultUnit); five call sites used to disagree about it
      { label: 'Sandsäcke', menge: undefined, unit: 'Stk.' },
      { label: 'Spezialschaum', menge: '20', unit: 'l' },
    ])
    // blank form: the whole catalogue as stubs, nothing dropped
    expect(mittelFormForPdf([], catalogue).mittelForm.every((r) => r.menge === undefined)).toBe(true)
  })
})

describe('operational extent', () => {
  it('excludes live GPS vehicles unless requested and includes circle radius bounds', () => {
    const entities: Entity[] = [
      { id: 's', kind: 'symbol', layer: 'taktisch', coord: [7.1, 47.1], symbol: 'VKF X' },
      { id: 'v', kind: 'symbol', layer: 'fahrzeuge', coord: [8, 48], symbol: 'VKF Fahrzeug', live: true },
    ]
    const drawings: Drawing[] = [{ id: 'c', kind: 'circle', coords: [[7.2, 47.2]], color: '#f00', radiusM: 100 }]
    expect(operationalExtentPoints([7, 47], entities, drawings, false).some(([lng]) => lng === 8)).toBe(false)
    expect(operationalExtentPoints([7, 47], entities, drawings, true).some(([lng]) => lng === 8)).toBe(true)
    expect(operationalExtentPoints([7, 47], entities, drawings, false).length).toBeGreaterThan(3)
  })

  it('frames the PLACED content — the incident pin only anchors an empty scene', () => {
    const entities: Entity[] = [{ id: 's', kind: 'symbol', layer: 'taktisch', coord: [7.1, 47.1], symbol: 'VKF X' }]
    // far-away alarm pin must NOT widen the frame when content exists
    expect(operationalExtentPoints([6, 46], entities, [], false)).toEqual([[7.1, 47.1]])
    // nothing placed → the pin is the frame
    expect(operationalExtentPoints([6, 46], [], [], false)).toEqual([[6, 46]])
  })
})

describe('einsatzleiterFromScene (Rapport pre-fill)', () => {
  const sym = (id: string, symbol: string, extra: Partial<Entity> = {}): Entity =>
    ({ id, kind: 'symbol', layer: 'taktisch', coord: [7, 47], symbol, ...extra })

  it('reads the name off the Einsatzleiter glyph, its label as fallback', () => {
    expect(einsatzleiterFromScene([sym('a', 'VKF Einsatzleiter', { fields: { Name: 'Céline Widmer' } })])).toBe('Céline Widmer')
    expect(einsatzleiterFromScene([sym('a', 'VKF Einsatzleiter', { label: 'Hptm Meier' })])).toBe('Hptm Meier')
  })

  it('falls back to an Offizier with EL-Funktion, then to an «Einsatzleiter» field', () => {
    expect(einsatzleiterFromScene([sym('o', 'FW Offizier', { fields: { Funktion: 'Einsatzleiter', Name: 'Peter Schmid' } })])).toBe('Peter Schmid')
    expect(einsatzleiterFromScene([sym('k', 'VKF KP Front', { fields: { Einsatzleiter: 'Hptm Meier' } })])).toBe('Hptm Meier')
  })

  it('prefers the EL glyph over the other two, and stays undefined without a person', () => {
    const scene = [
      sym('k', 'VKF KP Front', { fields: { Einsatzleiter: 'Falsch' } }),
      sym('a', 'VKF Einsatzleiter', { fields: { Name: 'Richtig', 'Stv.': 'Nebenrolle' } }),
    ]
    expect(einsatzleiterFromScene(scene)).toBe('Richtig')
    // an empty glyph names nobody — the field stays blank rather than guessing
    expect(einsatzleiterFromScene([sym('a', 'VKF Einsatzleiter', { fields: { Name: '  ' } })])).toBeUndefined()
    expect(einsatzleiterFromScene([])).toBeUndefined()
    expect(einsatzleiterFromScene()).toBeUndefined()
  })
})

describe('truppAuftragLabel (Auftrag on the Atemschutz sheet)', () => {
  it('resolves the stored id to its display label', () => {
    expect(truppAuftragLabel('loeschen')).toBe('Löschen')
    expect(truppAuftragLabel('retten')).toBe('Retten')
  })

  it('spells an unknown id instead of printing it raw — «loeschen», not «loeschen»', () => {
    // a Trupp from an older workspace, or a station that renamed its Auftrag types
    expect(truppAuftragLabel('loeschangriff')).toBe('Löschangriff')
    expect(truppAuftragLabel('geraetetraeger')).toBe('Gerätetraeger')
  })

  it('stays undefined without an Auftrag', () => {
    expect(truppAuftragLabel()).toBeUndefined()
    expect(truppAuftragLabel('')).toBeUndefined()
  })
})

describe('spanAwareClock (one midnight rule for the whole sheet)', () => {
  const oneDay = { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-23T11:00:00' }
  const overnight = { alarmedAt: '2026-06-23T23:50:00', endedAt: '2026-06-24T02:30:00' }

  it('stays on bare clocks for an ordinary Einsatz', () => {
    expect(spanAwareClock(oneDay)('2026-06-23T08:23:00')).toBe('08:23')
  })

  it('carries the date once the Einsatz runs past midnight', () => {
    // «23:50 → 00:15» is 25 minutes or 23 hours depending on a date that was nowhere on the paper
    expect(spanAwareClock(overnight)('2026-06-23T23:50:00')).toBe('23.06. 23:50')
    expect(spanAwareClock(overnight)('2026-06-24T00:15:00')).toBe('24.06. 00:15')
  })

  it('is undefined for nothing, and bare when the bounds are unknown', () => {
    expect(spanAwareClock(overnight)()).toBeUndefined()
    expect(spanAwareClock(overnight)('nonsense')).toBeUndefined()
    expect(spanAwareClock()('2026-06-23T08:23:00')).toBe('08:23')
  })
})

describe('metaExtrasForPdf follows the same rule as the roster above it', () => {
  const meta = {
    rueckmeldungElz: { name: 'Widmer Céline', at: '2026-06-24T00:15:00' },
    gruppen: [{ id: 'g1', alarmedAt: '2026-06-23T23:50:00' }],
    fahrzeuge: [{ id: 'tlf', ausgerueckt: '2026-06-24T00:05:00' }],
  } as unknown as Parameters<typeof metaExtrasForPdf>[0]

  it('dates the Zeiten grid and the Rückmeldung on an overnight Einsatz', () => {
    const out = metaExtrasForPdf(meta, { alarmedAt: '2026-06-23T23:50:00', endedAt: '2026-06-24T02:30:00' })
    expect(out.rueckmeldungElz).toBe('Widmer Céline · 24.06. 00:15')
    expect(out.zeiten.find(([label]) => label.startsWith('Gr. 1'))?.[1]).toBe('23.06. 23:50')
    expect(out.zeiten.find(([label]) => label === 'TLF')?.[1]).toBe('24.06. 00:05')
  })

  it('leaves an ordinary one-day sheet as narrow as it was', () => {
    const out = metaExtrasForPdf(meta, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-23T11:00:00' })
    expect(out.rueckmeldungElz).toBe('Widmer Céline · 00:15')
  })
})

describe('changedReportMetaFields (what the Verlauf row says)', () => {
  const base = { einsatzleiter: 'Widmer Céline', remarks: '' } as Parameters<typeof changedReportMetaFields>[0]

  it('quotes a short field rather than naming it in the abstract', () => {
    // «Rapportangaben geändert: Einsatzleiter» said that something happened to something
    const out = changedReportMetaFields(base, { ...base, einsatzleiter: 'Meier Hans' })
    expect(out).toEqual(['Einsatzleiter «Meier Hans»'])
  })

  it('says what happened to free text, never what it now says', () => {
    // the Verlauf is not a second copy of the rapport
    expect(changedReportMetaFields(base, { ...base, remarks: 'Zugang Hinterhof' })).toEqual(['Bemerkungen geschrieben'])
    const written = { ...base, remarks: 'Zugang Hinterhof' }
    expect(changedReportMetaFields(written, { ...written, remarks: 'Zugang Hof' })).toEqual(['Bemerkungen überarbeitet'])
    expect(changedReportMetaFields(written, { ...written, remarks: '' })).toEqual(['Bemerkungen geleert'])
  })

  it('reports a cleared short field as cleared, not as an empty quote', () => {
    expect(changedReportMetaFields(base, { ...base, einsatzleiter: '' })).toEqual(['Einsatzleiter geleert'])
  })

  it('stays silent when nothing worth a line moved', () => {
    expect(changedReportMetaFields(base, { ...base })).toEqual([])
    // bookkeeping about the rapport itself is not a statement about the Einsatz
    expect(changedReportMetaFields(base, { ...base, erfasser: 'FU' })).toEqual([])
  })

  // The six structured fields used to write nothing but their own name, so three taps on the
  // Partnerliste printed three identical «Partnerorganisationen» rows — a log that reads as a bug.
  it('names the Partnerorganisation that arrived, so consecutive rows are three statements', () => {
    const one = { ...base, partnerContacts: [{ org: 'Polizei' }] }
    expect(changedReportMetaFields(base, one)).toEqual(['Partnerorganisation Polizei ergänzt'])
    const two = { ...base, partnerContacts: [{ org: 'Polizei' }, { org: 'Sanität' }] }
    expect(changedReportMetaFields(one, two)).toEqual(['Partnerorganisation Sanität ergänzt'])
    expect(changedReportMetaFields(two, one)).toEqual(['Partnerorganisation Sanität entfernt'])
  })

  it('does not report the blank rows the Partner block always keeps ready', () => {
    expect(changedReportMetaFields(base, { ...base, partnerContacts: [{ org: '' }, { org: '' }] })).toEqual([])
  })

  it('carries the Partner remark — the reason the block exists', () => {
    const on = { ...base, partnerContacts: [{ org: 'Polizei' }] }
    expect(changedReportMetaFields(on, { ...base, partnerContacts: [{ org: 'Polizei', note: 'Wm. Keller, Verkehr' }] }))
      .toEqual(['Partnerorganisation Polizei – Bemerkung: Wm. Keller, Verkehr'])
  })

  it('says who reported back to the ELZ and when — the row the 10.08. test found empty', () => {
    const out = changedReportMetaFields(base, { ...base, rueckmeldungElz: { name: 'Widmer Céline', at: '2026-08-10T12:17:00Z' } })
    expect(out[0]).toContain('Rückmeldung ELZ durch Widmer Céline um ')
    expect(changedReportMetaFields(base, { ...base, rueckmeldungElz: { name: 'Widmer Céline' } }))
      .toEqual(['Rückmeldung ELZ durch Widmer Céline'])
  })

  it('counts the Gerettete instead of naming the field', () => {
    expect(changedReportMetaFields(base, { ...base, gerettete: { personen: 2, tiere: 1 } }))
      .toEqual(['Gerettete: 2 Personen · 1 Tier'])
  })

  it('distinguishes confirming «keine Mittel» from taking it back', () => {
    const on = { ...base, mittelConfirmedNone: true }
    expect(changedReportMetaFields(base, on)).toEqual(['Material: «keine verwendet» bestätigt'])
    expect(changedReportMetaFields(on, { ...base, mittelConfirmedNone: false })).toEqual(['Material: «keine verwendet» widerrufen'])
  })

  it('names the vehicle AND which of its three clocks moved', () => {
    const out = changedReportMetaFields(base, { ...base, fahrzeuge: [{ id: 'tlf', ausgerueckt: '2026-08-10T12:05:00Z' }] })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('ausgerückt')
    expect(out[0]).toContain('TLF') // the configured label, never the raw id
  })

  it('never prints a raw field identifier on the signed rapport', () => {
    // `startedAt` has no human name; a row reading «startedAt» is worse than no row
    expect(changedReportMetaFields(base, { ...base, startedAt: '2026-08-10T12:00:00Z' })).toEqual([])
  })
})

// The Rapport's «Aufträge / Pendenzen» section. Unlike the block in the Verlauf, this prints the
// CLOSED ones too — paper is a record, and a section showing only the leftovers would say what
// went wrong and nothing about what was ordered and done.
describe('report Pendenzen rows', () => {
  // exactly the shape addJournal writes: the lifecycle event rides on the ENTRY's own row
  const entry = (id: string, at: string, text: string, r: TimelineEvent['reminder']): TimelineEvent =>
    ({ id, t: at.slice(11, 16), at, icon: 'type', text, kind: 'journal', surface: 'map', reminder: r })

  const events: TimelineEvent[] = [
    entry('n2', '2026-08-16T20:59:00.000Z', 'ooooke', { op: 'note', id: 'p2' }),
    entry('d1', '2026-08-16T20:59:30.000Z', 'erledigt', { op: 'done', id: 'p1' }),
    entry('n1', '2026-08-16T20:59:10.000Z', 'Fahrzeug unterwegs', { op: 'note', id: 'p1' }),
    entry('e2', '2026-08-16T20:58:30.000Z', 'Auftrag · Patient an Sanität übergeben',
      { op: 'created', id: 'p2', text: 'Patient an Sanität übergeben', assignee: 'Sanität' }),
    entry('e1', '2026-08-16T20:58:00.000Z', 'Testpendenz 1',
      { op: 'created', id: 'p1', text: 'Testpendenz 1', urgent: true }),
  ]

  it('lists both the closed and the still-open item, oldest first', () => {
    const rows = pendenzRows(events)
    expect(rows.map((r) => r.text)).toEqual(['Testpendenz 1', 'Patient an Sanität übergeben'])
    expect(rows[0].erledigt).toBeTruthy()
    expect(rows[1].erledigt).toBeUndefined() // prints «offen»
  })

  it('prints the bare text, not the row with its «Auftrag · » tag', () => {
    expect(pendenzRows(events)[1].text).toBe('Patient an Sanität übergeben')
  })

  it('carries urgency, the assignee and every Meldung', () => {
    const [first, second] = pendenzRows(events)
    expect(first.urgent).toBe(true)
    expect(first.notes.map((n) => n.text)).toEqual(['Fahrzeug unterwegs'])
    expect(second.assignee).toBe('Sanität')
    expect(second.notes.map((n) => n.text)).toEqual(['ooooke'])
  })

  it('prints the Erinnerung, and a Meldung that reschedules moves it (same rule as the block)', () => {
    const timed: TimelineEvent[] = [
      // timezone-less stamps like the rest of this file, so the expected clock reads literally
      entry('n1', '2026-08-16T21:05:00.000Z', 'Werkhof meldet 20 Minuten',
        { op: 'note', id: 'p1', dueAt: '2026-08-16T21:25:00' }),
      entry('e1', '2026-08-16T21:00:00.000Z', 'Absperrmaterial',
        { op: 'created', id: 'p1', text: 'Absperrmaterial', dueAt: '2026-08-16T21:15:00' }),
      entry('e2', '2026-08-16T21:01:00.000Z', 'ohne Uhrzeit', { op: 'created', id: 'p2', text: 'ohne Uhrzeit' }),
    ]
    const [first, second] = pendenzRows(timed)
    expect(first.faellig).toBe('21:25') // moved by the Meldung, not the 21:15 it was raised with
    expect(second.faellig).toBeUndefined() // untimed item prints none
  })
})

// ⚠️ `contact` and `rueckzug` rows store the LAST reported value, not one taken at that moment —
// on the board that is context, in a signed document's pressure column it is a measurement that
// never happened.
describe('readingBarIsMeasured (which pressures the Rapport may print)', () => {
  it('prints a reading somebody actually took', () => {
    expect(readingBarIsMeasured('entry')).toBe(true)
    expect(readingBarIsMeasured('pressure')).toBe(true)
  })

  it('stays silent where the value was carried over', () => {
    expect(readingBarIsMeasured('contact')).toBe(false)
    expect(readingBarIsMeasured('rueckzug')).toBe(false)
  })
})

// ⚠️ The Verlauf is where the Rapport's journal comes from — a remark that never reaches it is a
// remark that never reaches the paper either.
describe('Partnerorganisationen in the Verlauf', () => {
  const lines = (before: unknown, after: unknown) =>
    changedReportMetaFields({ partnerContacts: before } as never, { partnerContacts: after } as never)

  it('logs the remark an organisation arrives with, not just the arrival', () => {
    // …both lines; the caller decides the order they land in the Verlauf (each becomes its own
    // row with its own clock, so it is the timestamps that order them, not this array)
    expect(lines([], [{ org: 'Sanität', note: 'avisiert, ETA 20 min' }]).sort()).toEqual([
      'Partnerorganisation Sanität ergänzt',
      'Partnerorganisation Sanität – Bemerkung: avisiert, ETA 20 min',
    ].sort())
  })

  it('logs a remark that was cleared — the one edit that used to leave no trace', () => {
    expect(lines([{ org: 'Polizei', note: 'Strasse gesperrt' }], [{ org: 'Polizei', note: '' }]))
      .toEqual(['Partnerorganisation Polizei – Bemerkung entfernt'])
  })

  it('says nothing when nothing about the remark changed', () => {
    const same = [{ org: 'Polizei', note: 'Strasse gesperrt' }]
    expect(lines(same, [{ ...same[0] }])).toEqual([])
  })
})
