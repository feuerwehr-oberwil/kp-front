import { describe, expect, it } from 'vitest'
import { matchesAny, stateMatches, toggled } from './attendanceFilter'
import type { AttendanceEntry } from '../types'

const entry = (over: Partial<AttendanceEntry> = {}): AttendanceEntry =>
  ({ status: 'present', ...over }) as AttendanceEntry

describe('stateMatches reads the same entry the row’s own marks do', () => {
  it('«frei» is the ABSENCE of an entry, not a status on one', () => {
    expect(stateMatches('frei', undefined)).toBe(true)
    expect(stateMatches('frei', entry({ status: 'left' }))).toBe(false)
  })

  it('separates anwesend from gegangen', () => {
    expect(stateMatches('present', entry({ status: 'present' }))).toBe(true)
    expect(stateMatches('left', entry({ status: 'present' }))).toBe(false)
    expect(stateMatches('left', entry({ status: 'left' }))).toBe(true)
  })

  // ⚠️ The reason Ort is not a facet of its own: a place only means something for somebody who
  // is here, so «im Magazin» must never match an absent AdF — however their `ort` happens to
  // have been left.
  it('places apply only to somebody who IS here', () => {
    expect(stateMatches('station', entry({ status: 'present', ort: 'station' }))).toBe(true)
    expect(stateMatches('station', entry({ status: 'left', ort: 'station' }))).toBe(false)
    expect(stateMatches('scene', entry({ status: 'left', ort: 'scene' }))).toBe(false)
  })

  it('treats an unset Ort as «Vor Ort» — the ordinary case is being at the Einsatz', () => {
    expect(stateMatches('scene', entry({ status: 'present' }))).toBe(true)
    expect(stateMatches('station', entry({ status: 'present' }))).toBe(false)
  })
})

describe('matchesAny — several picks inside one facet are an OR', () => {
  // The invariant the whole filter rests on: an untouched filter must not hide the list it
  // sits above. An empty set is «alle», never «keine».
  it('an empty selection matches everything', () => {
    expect(matchesAny(new Set(), () => false)).toBe(true)
  })

  it('«anwesend oder gegangen» is who was there at all', () => {
    const sel = new Set<'present' | 'left'>(['present', 'left'])
    const was = (a: AttendanceEntry | undefined) => matchesAny(sel, (k) => stateMatches(k, a))
    expect(was(entry({ status: 'present' }))).toBe(true)
    expect(was(entry({ status: 'left' }))).toBe(true)
    expect(was(undefined)).toBe(false)
  })
})

describe('toggled', () => {
  it('adds what is missing and removes what is there, without touching the original', () => {
    const a = new Set(['of'])
    const b = toggled(a, 'wm')
    expect([...b].sort()).toEqual(['of', 'wm'])
    expect([...toggled(b, 'of')]).toEqual(['wm'])
    expect([...a]).toEqual(['of']) // the state is the set — it is never mutated in place
  })
})
