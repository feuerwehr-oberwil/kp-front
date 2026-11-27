// «Beilagen › Fotos» lists the Verlauf's photos (lib/report · journalPhotos). Opening the Rapport
// must not build every print row of the Verlauf to find them (perf sweep 26.11.2026, finding 13),
// and the list must stay exactly what the Einsatzjournal prints.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineEvent } from '../types'
import { appConfig } from '../config/appConfig'
import { fatIncident } from './fatIncident'
import { journalPhotos, journalRows } from './report'
import { linkMarkup } from './journalLinks'

vi.mock('./journalLinks', async (importOriginal) => {
  const real = await importOriginal<typeof import('./journalLinks')>()
  return { ...real, linkMarkup: vi.fn(real.linkMarkup) }
})

/** What the list showed before finding 13: the print rows, one entry per picture. */
const fromPrintRows = (events: TimelineEvent[]) => journalRows(events, []).flatMap((r) =>
  (r.photoUrls ?? []).map((url, i) => ({ key: `${r.id}:${i}`, rowId: r.id, url, text: r.text, iso: r.iso })))

/** The `real` fat incident's Verlauf, with pictures on some rows – printed and excluded ones. */
function verlaufWithPhotos(): TimelineEvent[] {
  const rows = fatIncident({ scale: 1, hours: 5 }).journal.map((e, i) =>
    i % 37 === 0 ? { ...e, photoUrls: [`/media/p${i}a.jpg`, `/media/p${i}b.jpg`] }
      : i % 53 === 0 ? { ...e, photoUrl: `/media/p${i}.jpg`, text: i % 2 ? '' : e.text }
        : e)
  const at = '2026-09-20T15:00:00.000Z'
  return [
    ...rows,
    // print-excluded rows that carry a picture: none of these may be listed
    { id: 'x-layer', icon: 'pin', t: '15:00', at, text: 'Ebene ein', kind: 'layer', photoUrl: '/media/x1.jpg' },
    { id: 'x-people', t: '15:00', at, text: 'Meier Anna anwesend', kind: 'team', icon: 'people', photoUrl: '/media/x2.jpg' },
    { id: 'x-moved', icon: 'pin', t: '15:00', at, text: appConfig.copy.log.objectMoved.replace('{name}', 'Feuer'), kind: 'symbol', photoUrl: '/media/x3.jpg' },
    { id: 'x-empty', icon: 'pin', t: '15:00', at, text: '  ', kind: 'symbol', photoUrl: '/media/x4.jpg' },
    // the app's repeated line prints ONCE: the second picture row of the run is not listed
    { id: 'r1', icon: 'pin', t: '15:01', at: '2026-09-20T15:01:00.000Z', text: 'Lüfter läuft', kind: 'symbol', entityId: 'e1', photoUrl: '/media/r1.jpg' },
    { id: 'r2', icon: 'pin', t: '15:01', at: '2026-09-20T15:01:20.000Z', text: 'Lüfter läuft', kind: 'symbol', entityId: 'e1', photoUrl: '/media/r2.jpg' },
    // a printed row without a picture whose instant does not parse sits between two photo rows
    { id: 'p1', icon: 'pin', t: '15:02', at: '2026-09-20T15:02:00.000Z', text: 'Foto vorher', kind: 'journal', photoUrl: '/media/p1.jpg' },
    { id: 'bad', icon: 'pin', t: '15:03', at: 'kaputt', text: 'Zeit kaputt', kind: 'journal' },
    { id: 'p0', icon: 'pin', t: '14:59', at: '2026-09-20T14:59:00.000Z', text: 'Foto früher', kind: 'journal', photoUrl: '/media/p0.jpg' },
    // rows without an instant sort after the timed ones, by their «HH:MM»
    { id: 'n2', icon: 'pin', t: '09:30', text: 'ohne Zeitpunkt B', kind: 'journal', photoUrl: '/media/n2.jpg' },
    { id: 'n1', icon: 'pin', t: '08:15', text: 'Sofortmassnahme · ohne Zeitpunkt A', kind: 'journal', photoUrl: '/media/n1.jpg' },
  ]
}

describe('journalPhotos · the Verlauf\'s photos on «Beilagen › Fotos»', () => {
  beforeEach(() => { vi.mocked(linkMarkup).mockClear() })

  it('lists exactly what the Einsatzjournal prints – slot, text and time – and nothing it excludes', () => {
    const events = verlaufWithPhotos()
    const want = fromPrintRows(events)
    expect(want.length).toBeGreaterThan(10)
    expect(want.map((p) => p.rowId)).not.toContain('x-layer')
    expect(want.map((p) => p.rowId)).not.toContain('r2')
    expect(journalPhotos(events)).toEqual(want)
  })

  it('opening the Rapport builds no print row for a row without a picture', () => {
    const events = verlaufWithPhotos()
    expect(events.length).toBeGreaterThanOrEqual(316)
    journalPhotos(events)
    // the print row's link markup is its per-row cost (one call per printed row before)
    expect(vi.mocked(linkMarkup).mock.calls.length).toBe(0)
  })
})
