import { describe, expect, it } from 'vitest'
import { newVisitDoc } from './doc'
import { photoFileName, visitFileStem, visitText } from './report'

describe('export names and text', () => {
  it('names photos the way the filing does', () => {
    expect(photoFileName(0, 'Deckel klemmt', 'ova1759-1a2b', 'image/jpeg')).toBe('01 Deckel klemmt (1a2b).jpg')
    expect(photoFileName(11, '', 'ova1759-zz99', 'image/png')).toBe('12 (zz99).png')
    expect(photoFileName(1, 'a/b:c', 'ova1-abcd', 'image/webp')).toBe('02 abc (abcd).webp')
  })
  it('a readable text, «nicht geprüft» for open items', () => {
    const doc = {
      ...newVisitDoc({ object: { id: 'o', name: 'Werkhof', address: 'Sägestrasse 9' }, checklist: {
        id: 't', kind: 'visit' as const, version: 1, title: 'T', source: 's',
        phases: [{ id: 'p', title: 'P', items: [{ id: 'a', text: 'Zugang' }, { id: 'b', text: 'Schlüssel passt' }] }],
      } }),
      answers: { a: { v: 'defect', note: 'klemmt' } },
      notes: 'Hauswart neu',
      proposals: [{ id: 'ovp1', field: 'x', label: 'Kontakt', current: 'Brunner', proposed: 'Keller' }],
    }
    const t = visitText(doc, { check: { ok: 'OK', defect: 'Mangel', na: 'n. a.' }, open: 'nicht geprüft', notes: 'Bemerkungen', proposals: 'Vorschläge' })
    expect(t).toContain('- Zugang: Mangel (klemmt)')
    expect(t).toContain('- Schlüssel passt: nicht geprüft')
    expect(t).toContain('Hauswart neu')
    expect(t).toContain('- Kontakt: Brunner → Keller')
    expect(visitFileStem(doc)).toMatch(/^Objektbesuch \d{4}-\d\d-\d\d Werkhof$/)
  })
  it('a visit at a place carries the place into the file (no object)', () => {
    const place = { kind: 'location' as const, label: 'bei Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen', lat: 47.52015, lng: 7.57175 }
    const doc = newVisitDoc({ place, checklist: null })
    expect(doc.object).toBeNull()
    expect(doc.target).toEqual(place)
    const t = visitText(doc, { check: {}, open: 'nicht geprüft', notes: 'Bemerkungen', proposals: 'Vorschläge' })
    expect(t.split('\n')[0]).toMatch(/^bei Talholzstrasse 15 · Talholzstrasse 15, 4103 Bottmingen · LV95 2.610.0\d\d \/ 1.263.\d\d\d · WGS84 47\.52015, 7\.57175$/)
    expect(visitFileStem(doc)).toMatch(/^Objektbesuch \d{4}-\d\d-\d\d bei Talholzstrasse 15$/)
  })
})
