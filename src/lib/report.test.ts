import { describe, expect, it, vi } from 'vitest'
import type { BoardDoc, Drawing, Entity, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'

// The Zeiten grid is built from the deployment's Gruppen/Fahrzeuge, so the rows have to come
// from a config. Oberwil's shape in miniature: two groups (one with a colour), two vehicles.
const deployment = {
  alarms: { groups: [{ id: 'g1', label: 'Gr. 1', color: 'Rot' }, { id: 'tgp', label: 'Gr. 9' }] },
  fleet: { vehicles: [{ id: 'tlf', label: 'TLF' }, { id: 'pio', label: 'Pio' }] },
}
vi.mock('./deploymentConfig', () => ({ getDeploymentConfig: () => deployment }))
import {
  annotatedPlans,
  einsatzleiterFromScene,
  eventIso,
  hasVisiblePlanAnnotation,
  journalRows,
  metaExtrasForPdf,
  missingTranscriptCount,
  mittelFormForPdf,
  operationalExtentPoints,
  personalForPdf,
  proofLabel,
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
    expect(personal[0]).toMatchObject({ name: 'Meier Anna', erfasst: true, von: '09:05', bis: undefined })
    expect(personal[1]).toMatchObject({ name: 'Müller Hans', erfasst: false, von: undefined, bis: undefined })
    expect(personal[2]).toMatchObject({ name: 'Gast Vreni', erfasst: true, von: '09:00', bis: '10:30', bisDerived: false })
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
    expect(personal.map((p) => p.name)).toEqual(['Meier Anna', 'Meier Anna', 'Müller Hans', '', ''])
    expect(personal[0]).toMatchObject({ name: 'Meier Anna', erfasst: true, von: '09:00', bis: '11:00' })
    expect(personal[1]).toMatchObject({ name: 'Meier Anna', erfasst: true, von: '13:00', bis: '14:00' })
  })

  it('fills an open block with the Einsatzende and MARKS it as derived', () => {
    // the printed sheet is what WinFAP reads the hours off, so an open block has to carry a
    // time — but the grey says nobody measured it
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T09:05:00' },
    }, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    expect(personal[0]).toMatchObject({ von: '09:05', bis: '11:30', vonDerived: false, bisDerived: true })
  })

  it('derives BOTH ends for somebody ticked present with no times at all', () => {
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna' },
    }, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    // a line grey on both ends is one nobody has to check
    expect(personal[0]).toMatchObject({ erfasst: true, von: '09:00', bis: '11:30', vonDerived: true, bisDerived: true })
  })

  it('leaves an unrecorded person blank — a derived time must not invent attendance', () => {
    const { personal } = personalForPdf(roster, {}, { alarmedAt: '2026-06-23T09:00:00', endedAt: '2026-06-23T11:30:00' })
    expect(personal[0]).toMatchObject({ erfasst: false, von: undefined, bis: undefined })
  })

  it('carries the DATE once the Einsatz runs past midnight', () => {
    // «08:23 – 09:00» reads as 37 minutes when it was 25 hours
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T08:23:00' },
    }, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-24T09:00:00' })
    expect(personal[0].von).toBe('23.06. 08:23')
    expect(personal[0].bis).toBe('24.06. 09:00')
  })

  it('stays on bare clocks for an ordinary one-day Einsatz', () => {
    const { personal } = personalForPdf(roster, {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', checkedInAt: '2026-06-23T08:23:00' },
    }, { alarmedAt: '2026-06-23T08:00:00', endedAt: '2026-06-23T11:00:00' })
    expect(personal[0].von).toBe('08:23')
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
})

describe('server-PDF payload extras', () => {
  it('formats Gerettete and Rückmeldung ELZ, and stays empty when unset', () => {
    const extras = metaExtrasForPdf({
      gerettete: { personen: 2, tiere: 1 },
      rueckmeldungElz: { name: 'Muster Hans', at: '2026-07-18T17:15:00' },
    })
    expect(extras.gerettete).toBe('2 Personen · 1 Tiere')
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
      { label: 'Sandsäcke', menge: undefined, unit: 'Stk' },
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
