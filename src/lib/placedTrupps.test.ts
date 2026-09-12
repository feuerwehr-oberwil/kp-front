import { describe, expect, it } from 'vitest'
import { markerOptions, markerSite, nextTeamName, nextTruppNo, placedTrupps, resolveMarkerJoin, teamNameNo, truppMatches } from './placedTrupps'
import { searchQuery } from './search'
import { objectsFromLegacy } from './tacticalObjects'
import type { BoardAnno, BoardDoc, Entity, PlanDocument, Trupp } from '../types'

// «Wo steht Trupp 2» is asked of BOTH surfaces at once, so this list is the union of them —
// and it is keyed off the MARKER, because a team chip dropped straight onto the Lage is a
// placed Trupp even though the Atemschutz board has never heard of it.

const ent = (p: Partial<Entity> & { id: string }): Entity => ({
  kind: 'team', layer: 'taktik', coord: [7.57, 47.52], ...p,
} as Entity)

const anno = (p: Partial<BoardAnno> & { id: string }): BoardAnno => ({ kind: 'resource', ...p } as BoardAnno)
/** ⚠️ The store, not two collections: which SURFACE a marker stands on is its anchor now, and
 *  the Karte draws plan-anchored objects too — so membership of `entities` cannot answer it. */
const objs = (entities: Entity[], board: BoardDoc) => objectsFromLegacy(entities, [], board)

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
    const out = placedTrupps(objs(
      [ent({ id: 'e1', label: 'Trupp 1' }), ent({ id: 'e2', kind: 'symbol', label: 'nicht ein Trupp' })],
      { gebaeude: [anno({ id: 'a1', text: 'Trupp 2', floor: 2 })], modul3: [anno({ id: 'a2', text: 'Trupp 3' })] },
    ), PLANS, [])
    expect(out.map((t) => t.name)).toEqual(['Trupp 1', 'Trupp 2', 'Trupp 3'])
    expect(out.map((t) => t.where)).toEqual(['Karte', 'Gebäude · 2. OG', 'Modul 3'])
  })

  it('leaves a live vehicle alone — nobody placed it', () => {
    const out = placedTrupps(objs([ent({ id: 'v1', label: 'TLF 1', live: true })], {}), PLANS, [])
    expect(out).toHaveLength(0)
  })

  it('borrows members and status from the Atemschutz Trupp behind the marker', () => {
    const out = placedTrupps(objs([ent({ id: 'e1', label: 'Müller Hans', truppId: 'tr1' })], {}), PLANS, TRUPPS)
    expect(out[0].members).toEqual(['Müller Hans', 'Schmid Peter'])
    expect(out[0].status).toBe('angemeldet')
  })

  it('sinks a Trupp that has come back out, and counts past nine', () => {
    const raus = [{ ...TRUPPS[0], id: 'tr2', status: 'raus' } as Trupp]
    const out = placedTrupps(objs([ent({ id: 'a', label: 'Trupp 10' }), ent({ id: 'b', label: 'Trupp 2' }), ent({ id: 'c', label: 'Trupp 1', truppId: 'tr2' })], {}), PLANS, raus,
    )
    expect(out.map((t) => t.name)).toEqual(['Trupp 2', 'Trupp 10', 'Trupp 1'])
  })

  it('still lists a marker nobody named', () => {
    const out = placedTrupps(objs([ent({ id: 'e1' })], {}), PLANS, [])
    expect(out[0].name).toBe('Trupp')
  })
})

describe('truppMatches', () => {
  const [t] = placedTrupps(objs([ent({ id: 'e1', label: 'Trupp 1', truppId: 'tr1' })], {}), PLANS, TRUPPS)

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
    const out = placedTrupps(objs([], board), PLANS, TRUPPS)
    expect(out).toHaveLength(1)
    expect(out[0].where).toBe('Gebäude · EG')
  })
})

// ── joining a placed marker to an Atemschutz-Trupp ────────────────────────────────────────────
// The resolution only, i.e. what a join WOULD mean; the writes and the takeover confirm live in
// useTruppActions (adoptTruppMarker) and are tested there.
describe('resolveMarkerJoin', () => {
  const T2: Trupp = { ...TRUPPS[0], id: 'tr2', name: 'Keller Anna' }

  it('finds a loose team marker on the Lage — free, so no takeover', () => {
    const join = resolveMarkerJoin('e1', 'tr1', objs([ent({ id: 'e1', label: 'Trupp 2' })], {}), [TRUPPS[0]])
    expect(join?.site).toEqual({ kind: 'map', entityId: 'e1' })
    expect(join?.holder).toBeUndefined()
    expect(join?.own).toBe(false)
  })

  it('finds a resource chip on a plan and names the plan it lives on', () => {
    const board: BoardDoc = { gebaeude: [anno({ id: 'a1', text: 'Trupp 2' })] }
    expect(resolveMarkerJoin('a1', 'tr1', objs([], board), [TRUPPS[0]])?.site)
      .toEqual({ kind: 'plan', planId: 'gebaeude', annoId: 'a1' })
  })

  it('names the Trupp standing there — the one case that has to ask first', () => {
    const marker = ent({ id: 'e1', truppId: 'tr2' })
    const join = resolveMarkerJoin('e1', 'tr1', objs([marker], {}), [TRUPPS[0], { ...T2, entityId: 'e1' }])
    expect(join?.holder?.id).toBe('tr2')
  })

  // «own» is what stops a marker from being taken over from itself — that would ask the operator
  // to confirm handing a symbol from Trupp X to Trupp X
  it('reports the Trupp’s OWN marker as own, never as a takeover', () => {
    const join = resolveMarkerJoin('e1', 'tr1', objs([ent({ id: 'e1', truppId: 'tr1' })], {}), [{ ...TRUPPS[0], entityId: 'e1' }])
    expect(join?.own).toBe(true)
    expect(join?.holder).toBeUndefined()
  })

  // a Trupp taken off the Tafel still sits in the array (types · Trupp.removedAt); it must not
  // hold a symbol hostage behind a confirm naming a card nobody can see
  it('ignores a removed Trupp as holder', () => {
    const held = { ...T2, entityId: 'e1', removedAt: '2026-08-25T10:00:00Z' }
    expect(resolveMarkerJoin('e1', 'tr1', objs([ent({ id: 'e1', truppId: 'tr2' })], {}), [TRUPPS[0], held])?.holder)
      .toBeUndefined()
  })

  it('refuses anything that is not a placed Trupp', () => {
    const board: BoardDoc = { gebaeude: [anno({ id: 'd1', kind: 'draw' })] }
    // a tactical symbol, a live Fahrzeug off the GPS feed, a drawing, an id that names nothing
    expect(resolveMarkerJoin('s1', 'tr1', objs([ent({ id: 's1', kind: 'symbol' })], board), [TRUPPS[0]])).toBeUndefined()
    expect(resolveMarkerJoin('v1', 'tr1', objs([ent({ id: 'v1', live: true })], board), [TRUPPS[0]])).toBeUndefined()
    expect(resolveMarkerJoin('d1', 'tr1', objs([], board), [TRUPPS[0]])).toBeUndefined()
    expect(resolveMarkerJoin('nope', 'tr1', objs([], board), [TRUPPS[0]])).toBeUndefined()
  })
})

describe('markerOptions (what a Trupp card offers)', () => {
  const T2: Trupp = { ...TRUPPS[0], id: 'tr2', name: 'Keller Anna', entityId: 'e2' }

  it('offers free symbols first and says who holds the others', () => {
    const placed = placedTrupps(objs([ent({ id: 'e2', label: 'Keller Anna', truppId: 'tr2' }), ent({ id: 'e1', label: 'Trupp 9' })], {}), PLANS, [TRUPPS[0], T2],
    )
    const opts = markerOptions(placed, [TRUPPS[0], T2], 'tr1')
    expect(opts.map((o) => o.key)).toEqual(['e1', 'e2'])
    expect(opts[0].takenBy).toBeUndefined()
    expect(opts[0].where).toBe('Karte')
    // the HOLDER's name off the board, not the marker's label
    expect(opts[1].takenBy).toBe('Keller Anna')
  })

  it('leaves out the asking Trupp’s own symbol — picking it would change nothing', () => {
    const placed = placedTrupps(objs([ent({ id: 'e2', truppId: 'tr2' })], {}), PLANS, [T2])
    expect(markerOptions(placed, [T2], 'tr2')).toEqual([])
  })
})

describe('nextTeamName', () => {
  it('numbers past every chip it is shown, wherever that chip lives', () => {
    // both surfaces used to count separately, so a linked Karte and Modul each started at
    // «Trupp 1» — and the mirror showed the pair as one duplicated Trupp
    expect(nextTeamName(['Trupp 1', 'Trupp 3'])).toBe('Trupp 4')
    expect(nextTeamName([])).toBe('Trupp 1')
  })

  it('ignores renamed chips and real Trupp names — only the generic pattern counts', () => {
    expect(nextTeamName(['Verkehrsgruppe', 'Trupp Nord', 'Trupp 2', undefined])).toBe('Trupp 3')
  })

  // ONE counter per Einsatz (docs/trupp-naming.md §1): a registered Trupp's number counts too
  it('counts past the registered Trupps as well — removed ones included', () => {
    expect(nextTeamName(['Trupp 1'], [{ no: 4 }, { no: 2 }])).toBe('Trupp 5')
    expect(nextTeamName([], [{}])).toBe('Trupp 1')
  })
})

describe('nextTruppNo / teamNameNo', () => {
  it('reads the number off a generic chip and nothing else', () => {
    expect(teamNameNo('Trupp 7')).toBe(7)
    expect(teamNameNo(' trupp 12 ')).toBe(12)
    expect(teamNameNo('Trupp Nord')).toBeUndefined()
    expect(teamNameNo(undefined)).toBeUndefined()
  })

  it('is the max over Trupps and chips plus one, and starts at 1', () => {
    expect(nextTruppNo([{ no: 3 }], ['Trupp 5', 'Verkehr'])).toBe(6)
    expect(nextTruppNo([{ no: 3 }, { no: undefined }], [])).toBe(4)
    expect(nextTruppNo([], [])).toBe(1)
  })
})

/* ⚠️ THE regression (10.09.): the Karte draws plan-anchored objects itself now, so a plan chip's
 * id is in `entities` too — and «which collection holds it» stopped being «which surface is it
 * on». Read that way, a chip on a Modul answered «Lage»: it was listed under Karte, its join
 * wrote `entityId` instead of `annoId`+`planId` (so the record lost the plan coordinates the
 * Atemschutz card jumps to), the Verlauf said «auf der Karte platziert», and the picker offered
 * the same chip twice — twice under one React key. The ANCHOR is the only honest answer. */
describe('the surface a marker stands on is its anchor, not its collection membership', () => {
  const chip = objectsFromLegacy([], [], { modul3: [anno({ id: 'a1', text: 'Trupp 2' })] })
  // the Karte's copy of that very chip, exactly as the bake puts it into the entity view
  const withBakedBody = chip.map((o) => ({ ...o, entity: ent({ id: 'a1', label: 'Trupp 2' }) }))

  it('a plan chip that ALSO renders on the Karte is still on its plan', () => {
    expect(markerSite('a1', withBakedBody)).toEqual({ kind: 'plan', planId: 'modul3', annoId: 'a1' })
    expect(placedTrupps(withBakedBody, PLANS, []).map((t) => t.where)).toEqual(['Modul 3'])
  })

  it('…and it is listed ONCE, under one key', () => {
    const out = placedTrupps(withBakedBody, PLANS, [])
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('a1')
  })

  it('a map-anchored marker still reads as the Karte', () => {
    expect(markerSite('e1', objs([ent({ id: 'e1', label: 'Trupp 1' })], {}))).toEqual({ kind: 'map', entityId: 'e1' })
  })
})
