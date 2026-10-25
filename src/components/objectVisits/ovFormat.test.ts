import { describe, it, expect } from 'vitest'
import { answerDigest, conflictValue, recentPlaceVisits, summaryTitle, syncLabel, syncShort, visitTitle } from './ovFormat'
import { appConfig } from '../../config/appConfig'

// The head of a visit is one phone line (owner, 03.10.2026: «Entwur · Gespeichert 1 · Ablage wa»):
// where the glyph says what happened, only the time is left; the sheet keeps the long words.
describe('syncShort', () => {
  const at = '2026-10-03T13:42:00+02:00'
  it('drops the word where the glyph says it', () => {
    expect(syncShort({ kind: 'saved', at } as never)).toBe(syncLabel({ kind: 'saved', at } as never).replace(/^\D+/, ''))
    expect(syncShort({ kind: 'saved', at } as never)).not.toContain('Gespeichert')
    expect(syncShort({ kind: 'local', at } as never)).not.toMatch(/Gerät/)
  })
  it('keeps the word where there is no time to show', () => {
    expect(syncShort({ kind: 'conflict' } as never)).toBe(appConfig.copy.objectVisits.sync.conflict)
    expect(syncShort({ kind: 'local' } as never)).toBe(appConfig.copy.objectVisits.sync.local)
  })
})

describe('a visit at a place, named and summed up', () => {
  const place = { kind: 'location' as const, label: 'bei Talholzstrasse 15', address: null, lat: 47.52015, lng: 7.57175 }
  const fehler = {
    id: 'fehlermeldung', kind: 'visit' as const, version: 1, title: 'Fehlermeldung', source: 's', targets: ['object', 'location'] as ('object' | 'location')[],
    phases: [{ id: 'p', title: 'P', items: [
      { id: 'was', text: 'Was betrifft es?', input: 'choice' as const, options: [{ id: 'hydrant', label: 'Hydrant' }] },
      { id: 'beschreibung', text: 'Beschreibung', input: 'text' as const },
      { id: 'dringend', text: 'Dringend?', input: 'yesno' as const },
    ] }],
  }
  it('is called «Meldung bei …»; an object visit by its object', () => {
    expect(visitTitle({ object: null, target: place })).toBe('Meldung bei Talholzstrasse 15')
    expect(visitTitle({ object: { id: 'u1', name: 'Schulhaus' } })).toBe('Schulhaus')
    expect(summaryTitle({ objectName: null, target_kind: 'location', location: { label: 'bei Talholzstrasse 15', address: null, lat: 1, lng: 2 } })).toBe('Meldung bei Talholzstrasse 15')
    expect(summaryTitle({ objectName: 'Schulhaus' })).toBe('Schulhaus')
  })
  it('a checklist without OK/Mangel questions says what was reported — never «Keine Mängel»', () => {
    expect(answerDigest({ checklist: fehler, answers: { was: { v: 'hydrant' }, beschreibung: { v: 'Neuer Hydrant\nfehlt im Plan' }, dringend: { v: 'yes' } } }))
      .toBe('Hydrant · Neuer Hydrant fehlt im Plan')
    expect(answerDigest({ checklist: fehler, answers: {} })).toBeNull()
    const withCheck = { ...fehler, phases: [{ ...fehler.phases[0], items: [...fehler.phases[0].items, { id: 'ok', text: 'OK?' }] }] }
    expect(answerDigest({ checklist: withCheck, answers: { was: { v: 'hydrant' } } })).toBeNull()
    expect(answerDigest({ checklist: fehler, answers: { beschreibung: { v: 'x'.repeat(400) } } }, 20)).toHaveLength(20)
  })
  it('lists the finished visits at places, the device\'s copy over the server\'s row, newest first', () => {
    const doc = (id: string, lifecycle: 'draft' | 'completed', visitedAt: string) => ({
      schema: 'kp-front.object-visit/1' as const, id, object: null, target: place, visitedAt, lifecycle, checklist: fehler,
      answers: {}, notes: '', photos: [], proposals: [], with: ['Muster Max'],
    })
    const rows = recentPlaceVisits(
      [{ doc: doc('ov-a', 'completed', '2026-10-16T17:00:00+02:00') }, { doc: doc('ov-b', 'draft', '2026-10-16T18:00:00+02:00') }],
      [
        { id: 'ov-b', objectId: null, objectName: null, target_kind: 'location', location: { label: 'x', address: null, lat: 1, lng: 2 }, lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-16T18:00:00+02:00' },
        { id: 'ov-c', objectId: null, objectName: null, target_kind: 'location', location: { label: 'bei Hydrant', address: null, lat: 1, lng: 2 }, lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-17T08:00:00+02:00', checklist: { id: 'f', title: 'Fehlermeldung' } },
        { id: 'ov-d', objectId: 'u1', objectName: 'Schulhaus', lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-18T08:00:00+02:00' },
      ],
    )
    // ov-b is a draft on this device (the newer fact), ov-d is at an object
    expect(rows.map((r) => r.id)).toEqual(['ov-c', 'ov-a'])
    expect(rows[1]).toMatchObject({ label: 'bei Talholzstrasse 15', checklist: 'Fehlermeldung', people: 'Muster Max' })
  })
})

// The conflict card's «Besuchsdatum» sides: the date once, then the clock – on any day.
describe('conflictValue · visitedAt', () => {
  const doc = {} as Parameters<typeof conflictValue>[2]
  const c = { key: 'visitedAt' } as Parameters<typeof conflictValue>[0]
  it('names another day once («21.10.2026 14:05», not «21.10.2026 21.10. 14:05»)', () => {
    expect(conflictValue(c, new Date(2026, 9, 21, 14, 5).toISOString(), doc)).toBe('21.10.2026 14:05')
  })
  it('reads the same for today', () => {
    const now = new Date()
    now.setHours(9, 30, 0, 0)
    const day = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`
    expect(conflictValue(c, now.toISOString(), doc)).toBe(`${day} 09:30`)
  })
})
