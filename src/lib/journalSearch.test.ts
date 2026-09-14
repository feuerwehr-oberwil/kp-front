import { describe, expect, it } from 'vitest'
import { filterJournal, matchesJournalQuery } from './journalSearch'
import type { TimelineEvent } from '../types'

const row = (id: string, text: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, t: '', at: new Date(1_000_000).toISOString(), text, icon: 'type', kind: 'journal', ...over,
})

const events = [
  row('r1', 'Lage: Brand im 1. UG, Farblager, starke Rauchentwicklung'),
  row('r2', 'Trupp 2 (Fabich Mischa): Druckmeldung 180 bar'),
  row('r3', 'Notiz: Nachbarin sagt, Keller ist voll mit Farben und Lösungsmittel'),
  row('r4', 'Auftrag · Treppenhaus entrauchen', { reminder: { op: 'created', id: 'p1', assignee: 'Müller Hans' } }),
]

const ids = (raw: string) => filterJournal(events, raw).map((e) => e.id)

describe('journal search · the person search’s tolerance', () => {
  it('umlauts, both directions', () => {
    expect(ids('loesungsmittel')).toEqual(['r3'])
    expect(matchesJournalQuery(row('x', 'Mueller meldet'), 'müller')).toBe(true)
  })

  it('one typo from four characters up', () => {
    expect(ids('farlbager')).toEqual(['r1'])
    expect(ids('drukmeldung')).toEqual(['r2'])
  })

  it('a three-letter query is exact only', () => {
    expect(ids('bra')).toEqual(['r1']) // «Brand», as a fragment
    expect(ids('bxa')).toEqual([]) // …and not with a typo: three letters are too few to forgive one
  })

  it('finds a row by the person a Pendenz names', () => {
    expect(ids('mueller')).toEqual(['r4'])
  })

  it('a multi-word query needs every word, in any order', () => {
    expect(ids('farb keller')).toEqual(['r3'])
    expect(ids('keller farb')).toEqual(['r3'])
    expect(ids('farb pumpe')).toEqual([])
  })

  it('an empty query keeps everything, in order', () => {
    expect(ids('')).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(ids('   ')).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
})
