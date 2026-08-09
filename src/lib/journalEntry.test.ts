import { describe, expect, it } from 'vitest'
import type { AttendanceState, Person } from '../types'
import { acceptName, composeJournalText, journalSources, nameRanges as journalNameRanges, suggestNames } from './journalEntry'

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

  it('puts the crew who are HERE first, officers among them first', () => {
    const attendance: AttendanceState = {
      p1: here('Brunner Thomas'),
      p2: here('Meier Anna'),
      p4: { status: 'left', displayNameSnapshot: 'Graf Stefan', intervals: [{ from: 'x', to: 'y' }] },
    }
    const names = journalSources(personnel, attendance).map((s) => s.name)
    expect(names.slice(0, 2)).toEqual(['Meier Anna', 'Brunner Thomas'])
    // …and everybody else is still there, just after them
    expect(names).toContain('Graf Stefan')
    expect(names).toContain('Huber Sarah')
  })

  it('⚠️ offers EVERYBODY, with the crew on scene first', () => {
    // whoever a journal entry is about is very often not ticked present — the AdF still
    // driving in, the Kommandant on the phone — and a list that cannot spell their name is
    // worse than none. Attendance only decides the order.
    const attendance: AttendanceState = { p3: here('Huber Sarah') }
    const names = journalSources(personnel, attendance).map((s) => s.name)
    expect(names[0]).toBe('Huber Sarah')
    expect(names).toHaveLength(personnel.length)
    expect(names).toContain('Graf Stefan')
  })

  it('still lists the roster before anybody is ticked present', () => {
    expect(journalSources(personnel, {}).map((s) => s.name)).toHaveLength(personnel.length)
    expect(journalSources([], {})).toEqual([])
  })
})

describe('typing a name', () => {
  const sources = [
    { id: 'p1', name: 'Baumann Michael' },
    { id: 'p2', name: 'Meier Anna' },
    { id: 'p3', name: 'Brunner Thomas' },
  ]

  it('breaks a score tie on who is actually here', () => {
    const tie = [
      { id: 'a', name: 'Brunner Thomas', present: false },
      { id: 'b', name: 'Brunner Peter', present: true },
    ]
    expect(suggestNames('Brunner', tie).map((s) => s.name)[0]).toBe('Brunner Peter')
  })

  it('suggests on the WORD, not on the whole sentence', () => {
    expect(suggestNames('Meier meldet Baum', sources).map((s) => s.name)).toEqual(['Baumann Michael'])
  })

  it('stays quiet until the fragment could only be a name', () => {
    expect(suggestNames('Kellerbrand im', sources)).toEqual([])
    expect(suggestNames('Ba', sources)).toEqual([])
  })

  it('does not suggest a name that is already typed out', () => {
    expect(suggestNames('Baumann Michael', sources).map((s) => s.name)).not.toContain('Baumann Michael')
  })

  it('replaces the word and leaves a space to keep writing', () => {
    expect(acceptName('Meier meldet Baum', 'Baumann Michael')).toBe('Meier meldet Baumann Michael ')
    expect(acceptName('', 'Meier Anna')).toBe('Meier Anna ')
  })

  it('marks every known name in the text, longest first so they cannot overlap', () => {
    const text = 'Meier Anna und Brunner Thomas im 2. OG'
    const ranges = journalNameRanges(text, sources)
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['Meier Anna', 'Brunner Thomas'])
  })

  it('marks nothing when no roster name appears', () => {
    expect(journalNameRanges('Kellerbrand bestätigt', sources)).toEqual([])
  })
})
