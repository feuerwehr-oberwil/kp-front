import { describe, expect, it } from 'vitest'
import { alarmUpdateRow, inlineDiff, markNew } from './alarmUpdate'
import type { AlarmUpdate } from './incidents'

// Invented example data: Musterweg in Beispielstadt.
const update = (edited: boolean): AlarmUpdate => ({
  state: 'pending',
  at: '2026-11-15T13:52:00Z',
  title: 'Brand, Musterweg 21',
  lat: 47.2,
  lng: 8.2,
  fields: [
    { field: 'address', current: edited ? 'Musterweg 14' : 'Musterweg 12', alarm: 'Musterweg 21', edited },
    { field: 'text', current: 'Rauch aus Dachstock', alarm: 'Rauch aus Dachstock, Person vermisst', edited: false },
  ],
})

describe('alarmUpdateRow', () => {
  it('shows old → new and the new Meldung, and takes everything', () => {
    const row = alarmUpdateRow(update(false), 'Brand Musterweg')
    expect(row.title).toBe('Alarm aktualisiert – Brand')
    expect(row.sub).toEqual(['Adresse ', 'Musterweg ', { del: '12' }, ' ', { ins: '21' }])
    expect(row.sub2).toEqual(['Meldung ', 'Rauch aus Dachstock', { ins: ', Person vermisst' }])
    expect(row.takeLabel).toBe('Übernehmen')
  })

  it('keeps a hand-edited field, shows the alarm value beside it and names what the button takes', () => {
    const row = alarmUpdateRow(update(true), 'Brand Musterweg')
    expect(row.sub).toEqual(['Adresse bleibt ', { b: 'Musterweg 14' }, ' (von euch) · Alarm neu: ', 'Musterweg ', { ins: '21' }])
    expect(row.takeLabel).toBe('Meldung übernehmen')
  })

  it('offers no take when every changed field was edited by hand', () => {
    const u = update(true)
    expect(alarmUpdateRow({ ...u, fields: [u.fields[0]] }, 'X').takeLabel).toBeNull()
  })
})

describe('diff spans', () => {
  it('marks only what is new, by word', () => {
    expect(markNew('Rauch', 'Rauch')).toEqual(['Rauch'])
    expect(inlineDiff('Musterweg 12, 9999 Beispielstadt', 'Musterweg 21, 9999 Beispielstadt'))
      .toEqual(['Musterweg ', { del: '12' }, ' ', { ins: '21' }, ', 9999 Beispielstadt'])
  })
})
