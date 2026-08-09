import { describe, expect, it } from 'vitest'
import type { AttendanceState, Person } from '../types'
import { composeJournalText, journalSources } from './journalEntry'

describe('composeJournalText', () => {
  it('leaves a bare entry exactly as it was written', () => {
    expect(composeJournalText('Kellerbrand bestätigt')).toBe('Kellerbrand bestätigt')
  })

  it('puts who said it in front', () => {
    expect(composeJournalText('Kellerbrand bestätigt', { source: { name: 'Meier Anna' } }))
      .toBe('Meier Anna: Kellerbrand bestätigt')
  })

  it('⚠️ prints NO marker for «Info» — a marker on the ordinary case is wallpaper', () => {
    expect(composeJournalText('Kellerbrand bestätigt', { entryType: 'info' }))
      .toBe('Kellerbrand bestätigt')
    expect(composeJournalText('Kellerbrand bestätigt', { entryType: 'info', source: { name: 'Meier Anna' } }))
      .toBe('Meier Anna: Kellerbrand bestätigt')
  })

  it('marks the two that are not ordinary', () => {
    expect(composeJournalText('Trupp 2 sichert Treppenhaus', { entryType: 'auftrag', source: { name: 'Einsatzleiter' } }))
      .toBe('Auftrag · Einsatzleiter: Trupp 2 sichert Treppenhaus')
    expect(composeJournalText('Strom abstellen', { entryType: 'sofort', source: { name: 'ELZ' } }))
      .toBe('Sofortmassnahme · ELZ: Strom abstellen')
  })

  it('keeps a source-only row readable when there are no words — a photo brought by somebody', () => {
    expect(composeJournalText('', { source: { name: 'Meier Anna' } })).toBe('Meier Anna')
    expect(composeJournalText('   ', { entryType: 'sofort' })).toBe('Sofortmassnahme')
  })
})

describe('journalSources', () => {
  const person = (id: string, displayName: string, rank?: string): Person => ({
    id, displayName, rank, active: true, updatedAt: '2026-08-09T00:00:00.000Z',
  })
  const here = (name: string) => ({
    status: 'present' as const, displayNameSnapshot: name,
    intervals: [{ from: '2026-08-08T22:11:00Z' }],
  })

  const personnel = [
    person('p1', 'Brunner Thomas'),
    person('p2', 'Meier Anna', 'oblt'),
    person('p3', 'Huber Sarah'),
    person('p4', 'Graf Stefan'),
  ]

  it('offers only the people who are HERE — somebody who went home is not reporting', () => {
    const attendance: AttendanceState = {
      p1: here('Brunner Thomas'),
      p2: here('Meier Anna'),
      p4: { status: 'left', displayNameSnapshot: 'Graf Stefan', intervals: [{ from: 'x', to: 'y' }] },
    }
    expect(journalSources(personnel, attendance).map((s) => s.name))
      // officers first: they are the ones who report
      .toEqual(['Meier Anna', 'Brunner Thomas'])
  })

  it('caps the row so it stays two lines of chips', () => {
    const many = Array.from({ length: 12 }, (_, i) => person(`x${i}`, `Muster ${i}`))
    const attendance: AttendanceState = Object.fromEntries(many.map((p) => [p.id, here(p.displayName)]))
    expect(journalSources(many, attendance)).toHaveLength(6)
    expect(journalSources(many, attendance, 3)).toHaveLength(3)
  })

  it('is empty before anybody is ticked present', () => {
    expect(journalSources(personnel, {})).toEqual([])
  })
})
