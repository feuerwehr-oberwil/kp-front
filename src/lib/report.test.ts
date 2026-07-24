import { describe, expect, it } from 'vitest'
import type { BoardDoc, Drawing, Entity, MittelEntry, PlanDocument, TimelineEvent, Trupp } from '../types'
import {
  annotatedPlans,
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
    expect(personal[0]).toEqual({ name: 'Meier Anna', erfasst: true, von: '09:05', bis: undefined })
    expect(personal[1]).toEqual({ name: 'Müller Hans', erfasst: false, von: undefined, bis: undefined })
    expect(personal[2]).toEqual({ name: 'Gast Vreni', erfasst: true, von: '09:00', bis: '10:30' })
    expect(personal[3].erfasst).toBe(false)
  })

  it('prints the full roster untouched when nothing was recorded (blank form)', () => {
    const { personal } = personalForPdf(roster, {})
    expect(personal).toHaveLength(4) // roster + 2 write-in rows
    expect(personal.every((p) => !p.erfasst)).toBe(true)
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
