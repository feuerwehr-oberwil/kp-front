import { describe, expect, it } from 'vitest'
import { buildDirectReportPayload } from './reportPdfDirect'
import type { SucheDoc } from '../types'

/** The Suche's «Personen» (24.09.2026): one line per person, then the one Bereiche line — from
 *  the same slice the app lists, with the building's own storey names (a step-1 record carries
 *  a storey; the places entered since are words). */
describe('buildDirectReportPayload · personen', () => {
  const suche: SucheDoc = {
    personen: [{ id: 'p1', name: 'Tim Muster', floor: 1, createdAt: '2026-09-03T10:08:00.000Z', log: [
      { id: 'r1', op: 'vermisst', at: '2026-09-03T10:08:00.000Z', text: 'Vermisst: Tim Muster' },
      { id: 'r2', op: 'gefunden', at: '2026-09-03T10:16:00.000Z', text: 'Gefunden: Tim Muster', trupp: 'Trupp 3', floor: 1 },
    ] }],
    bereiche: [{ id: 'sbg:k1:1', floor: 1, stack: 'k1', createdAt: '', log: [{ id: 'r3', op: 'status', status: 'abgesucht', at: '2026-09-03T10:39:00.000Z', text: 'x' }] }],
  }
  const payload = (personen: boolean) => buildDirectReportPayload({
    incident: { id: 'i1', title: 'Brand', started_at: '2026-09-03T09:50:00.000Z' } as never,
    draft: { meta: {}, generatedAt: '2026-09-03T12:00:00.000Z', proof: {}, options: { personen } } as never,
    trupps: [], attendance: {}, events: [], plans: [], suche,
    building: { ring: [], ringAspect: 1, floors: [0, 1], floorNames: { 1: 'Hauptgeschoss' } },
    // the app's own reading of the Gebäude (IncidentWorkspace · sucheStack) — the paper counts what it counts
    sucheStack: { floorName: (f) => (f === 1 ? 'Hauptgeschoss' : f === 0 ? 'EG' : `${f}`) },
  }) as { personen: { name: string; gefunden?: string }[]; sucheLine?: string }

  it('prints the person with its times and the Bereiche line, in the building\'s own storey names', () => {
    const out = payload(true)
    expect(out.personen.map((p) => p.name)).toEqual(['Tim Muster'])
    expect(out.personen[0].gefunden).toContain('Hauptgeschoss')
    // the one place that was ever touched — no storey nobody entered (the EG is not on the list)
    expect(out.sucheLine).toMatch(/^Suche: 1 Bereich, abgesucht \d\d:39$/)
  })

  it('prints nothing of it when the section is switched off', () => {
    const out = payload(false)
    expect(out.personen).toEqual([])
    expect(out.sucheLine).toBeUndefined()
  })
  it('dates the Suche times when a reopen moved the Einsatzende to the next day (latest close, not the first)', () => {
    // closed the same day, reopened, closed again a day later: the Suche's times span two days,
    // so each carries its date — measured against the LATEST close (closeTimeOf), not the first
    const found = '2026-09-04T09:00:00.000Z'
    const out = buildDirectReportPayload({
      incident: { id: 'i1', title: 'Brand', started_at: '2026-09-03T10:00:00.000Z', is_archived: true,
        closed_at: '2026-09-03T11:00:00.000Z', last_closed_at: '2026-09-04T11:00:00.000Z' } as never,
      draft: { meta: {}, generatedAt: '2026-09-04T12:00:00.000Z', proof: {}, options: { personen: true } } as never,
      trupps: [], attendance: {}, events: [], plans: [],
      suche: { personen: [{ id: 'p2', name: 'Eva Beispiel', createdAt: '2026-09-03T10:30:00.000Z', log: [
        { id: 'v', op: 'vermisst', at: '2026-09-03T10:30:00.000Z', text: 'Vermisst: Eva Beispiel' },
        { id: 'g', op: 'gefunden', at: found, text: 'Gefunden: Eva Beispiel' },
      ] }], bereiche: [] },
    }) as { personen: { name: string; gefunden?: string }[] }
    const d = new Date(found)
    const day = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
    expect(out.personen[0].gefunden).toContain(day)
  })
})

