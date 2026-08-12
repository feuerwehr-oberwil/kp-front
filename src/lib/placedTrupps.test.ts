import { describe, expect, it } from 'vitest'
import { placedTrupps, truppMatches } from './placedTrupps'
import { searchQuery } from './search'
import type { BoardAnno, BoardDoc, Entity, PlanDocument, Trupp } from '../types'

// «Wo steht Trupp 2» is asked of BOTH surfaces at once, so this list is the union of them —
// and it is keyed off the MARKER, because a team chip dropped straight onto the Lage is a
// placed Trupp even though the Atemschutz board has never heard of it.

const ent = (p: Partial<Entity> & { id: string }): Entity => ({
  kind: 'team', layer: 'taktik', coord: [7.57, 47.52], ...p,
} as Entity)

const anno = (p: Partial<BoardAnno> & { id: string }): BoardAnno => ({ kind: 'resource', ...p } as BoardAnno)

const PLANS: PlanDocument[] = [
  { id: 'gebaeude', code: 'Gebäude', title: '', subtitle: '', imageUrl: '', orientation: 'landscape', floorStack: true },
  { id: 'modul3', code: 'Modul 3', title: '', subtitle: '', imageUrl: '', orientation: 'landscape' },
]

const TRUPPS: Trupp[] = [{
  id: 'tr1', name: 'Müller Hans', members: ['Schmid Peter'], status: 'angemeldet',
  entryPressureBar: 300, entryTime: '', lastContactTime: '', lowestBar: 300, readings: [],
} as Trupp]

describe('placedTrupps', () => {
  it('takes team markers off the Lage and resource chips off every plan', () => {
    const out = placedTrupps(
      [ent({ id: 'e1', label: 'Trupp 1' }), ent({ id: 'e2', kind: 'symbol', label: 'nicht ein Trupp' })],
      { gebaeude: [anno({ id: 'a1', text: 'Trupp 2', floor: 2 })], modul3: [anno({ id: 'a2', text: 'Trupp 3' })] },
      PLANS, [],
    )
    expect(out.map((t) => t.name)).toEqual(['Trupp 1', 'Trupp 2', 'Trupp 3'])
    expect(out.map((t) => t.where)).toEqual(['Lage', 'Gebäude · 2. OG', 'Modul 3'])
  })

  it('leaves a live vehicle alone — nobody placed it', () => {
    const out = placedTrupps([ent({ id: 'v1', label: 'TLF 1', live: true })], {}, PLANS, [])
    expect(out).toHaveLength(0)
  })

  it('borrows members and status from the Atemschutz Trupp behind the marker', () => {
    const out = placedTrupps([ent({ id: 'e1', label: 'Müller Hans', truppId: 'tr1' })], {}, PLANS, TRUPPS)
    expect(out[0].members).toEqual(['Müller Hans', 'Schmid Peter'])
    expect(out[0].status).toBe('angemeldet')
  })

  it('sinks a Trupp that has come back out, and counts past nine', () => {
    const raus = [{ ...TRUPPS[0], id: 'tr2', status: 'raus' } as Trupp]
    const out = placedTrupps(
      [ent({ id: 'a', label: 'Trupp 10' }), ent({ id: 'b', label: 'Trupp 2' }), ent({ id: 'c', label: 'Trupp 1', truppId: 'tr2' })],
      {}, PLANS, raus,
    )
    expect(out.map((t) => t.name)).toEqual(['Trupp 2', 'Trupp 10', 'Trupp 1'])
  })

  it('still lists a marker nobody named', () => {
    const out = placedTrupps([ent({ id: 'e1' })], {}, PLANS, [])
    expect(out[0].name).toBe('Trupp')
  })
})

describe('truppMatches', () => {
  const [t] = placedTrupps([ent({ id: 'e1', label: 'Trupp 1', truppId: 'tr1' })], {}, PLANS, TRUPPS)

  it('finds a Trupp by its own name', () => {
    expect(truppMatches(t, searchQuery('trupp 1')!)).toBe(true)
  })

  // the whole point of searching an AdF: you know who went in, not which number they got
  it('finds it by somebody IN it — umlauts and one typo included', () => {
    expect(truppMatches(t, searchQuery('schmid')!)).toBe(true)
    expect(truppMatches(t, searchQuery('mueller')!)).toBe(true)
    expect(truppMatches(t, searchQuery('mueler')!)).toBe(true)
  })

  it('does not match somebody who is not in it', () => {
    expect(truppMatches(t, searchQuery('keller')!)).toBe(false)
  })
})

// a Trupp that moved from the Lage onto a plan must not appear twice; the marker is the record
describe('one marker, one row', () => {
  it('lists a Trupp once per PLACE it stands', () => {
    const board: BoardDoc = { gebaeude: [anno({ id: 'a1', text: 'Trupp 1', truppId: 'tr1', floor: 0 })] }
    const out = placedTrupps([], board, PLANS, TRUPPS)
    expect(out).toHaveLength(1)
    expect(out[0].where).toBe('Gebäude · EG')
  })
})
