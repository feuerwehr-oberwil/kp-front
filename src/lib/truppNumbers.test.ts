import { describe, expect, it } from 'vitest'
import { renumberRow, resolveTruppNumbers, truppRenumberings } from './truppNumbers'
import { nextTruppNo } from './placedTrupps'
import type { TacticalObject } from './tacticalObjects'
import type { Trupp } from '../types'

// Registration writes `registered` + `crew` at the same instant (useTruppActions · createTrupp).
const trupp = (id: string, no: number | undefined, at: string, extra: Partial<Trupp> = {}): Trupp => ({
  id, no, name: `GF ${id}`, members: [], status: 'angemeldet', pressure: 300, entryPressureBar: 300,
  readings: [{ t: at, bar: 300, kind: 'registered' }, { t: at, bar: 300, kind: 'crew', crew: { name: `GF ${id}`, members: [] } }],
  ...extra,
} as unknown as Trupp)
/** a loose marker on the Karte, as useTeamMarkerActions · placeGenericTeam drops it */
const chip = (id: string, label: string, truppId?: string): TacticalObject => ({
  id, entity: { id, kind: 'team', layer: 'ops', coord: [8, 46], label, ...(truppId ? { truppId } : {}) } as TacticalObject['entity'],
})
/** a loose chip on a plan sheet (its baked Karte body carries the same label) */
const sheetChip = (id: string, text: string): TacticalObject => ({
  id,
  sheet: { planId: 'modul6', anno: { id, kind: 'resource', x: 0.5, y: 0.5, text } as NonNullable<TacticalObject['sheet']>['anno'] },
  entity: { id, kind: 'team', layer: 'ops', coord: [8, 46], label: text } as TacticalObject['entity'],
})
const labelOf = (o: TacticalObject) => o.sheet?.anno.text ?? o.entity?.label

describe('resolveTruppNumbers — one number, one holder', () => {
  it('returns null when nothing is contested (nothing is copied)', () => {
    expect(resolveTruppNumbers([trupp('a', 1, '2026-09-25T10:00:00Z'), trupp('b', 2, '2026-09-25T10:00:01Z')], [chip('c', 'Trupp 3')])).toBeNull()
  })

  it('three Trupps registered at once: the first registered keeps 1, the others take 2 and 3', () => {
    const ts = [
      trupp('trC', 1, '2026-09-25T10:00:00.030Z'),
      trupp('trA', 1, '2026-09-25T10:00:00.010Z'),
      trupp('trB', 1, '2026-09-25T10:00:00.020Z'),
    ]
    const r = resolveTruppNumbers(ts, [])!
    expect(Object.fromEntries(r.trupps.map((t) => [t.id, t.no]))).toEqual({ trA: 1, trB: 2, trC: 3 })
    // the order of the array is not the order of the numbers — it is the merge's order, untouched
    expect(r.trupps.map((t) => t.id)).toEqual(['trC', 'trA', 'trB'])
  })

  it('is independent of the order the merge happened to list them in', () => {
    const ts = [trupp('trA', 1, '2026-09-25T10:00:00.010Z'), trupp('trB', 1, '2026-09-25T10:00:00.020Z'), trupp('trC', 1, '2026-09-25T10:00:00.030Z')]
    const numbers = (list: Trupp[]) => Object.fromEntries(resolveTruppNumbers(list, [])!.trupps.map((t) => [t.id, t.no]))
    expect(numbers([...ts].reverse())).toEqual(numbers(ts))
    expect(numbers([ts[1], ts[2], ts[0]])).toEqual(numbers(ts))
  })

  it('new numbers come from the ONE counter: above every Trupp, removed ones and chips included', () => {
    const ts = [
      trupp('old', 7, '2026-09-25T09:00:00Z', { removedAt: '2026-09-25T09:10:00Z' }), // never reused
      trupp('a', 1, '2026-09-25T10:00:00.010Z'),
      trupp('b', 1, '2026-09-25T10:00:00.020Z'),
    ]
    const r = resolveTruppNumbers(ts, [chip('loose', 'Trupp 9')])!
    expect(r.trupps.find((t) => t.id === 'b')!.no).toBe(10)
    expect(nextTruppNo(r.trupps, r.objects.map(labelOf))).toBe(11)
  })

  it('a Trupp that already WENT IN keeps its number over one registered earlier that did not', () => {
    const early = trupp('early', 2, '2026-09-25T10:00:00Z')
    const inside = trupp('inside', 2, '2026-09-25T10:00:05Z', {
      status: 'aktiv', entryTime: '2026-09-25T10:00:30Z',
    } as Partial<Trupp>)
    inside.readings = [...inside.readings!, { t: '2026-09-25T10:00:30Z', bar: 300, kind: 'entry' }]
    const r = resolveTruppNumbers([early, inside], [])!
    expect(r.trupps.find((t) => t.id === 'inside')!.no).toBe(2)
    expect(r.trupps.find((t) => t.id === 'early')!.no).toBe(3)
  })

  it('a registered Trupp keeps its number over a loose chip, which is relabelled', () => {
    const r = resolveTruppNumbers([trupp('tr', 1, '2026-09-25T10:00:05Z')], [chip('trupp1758794400000-00ab', 'Trupp 1')])!
    expect(r.trupps[0].no).toBe(1)
    expect(r.objects[0].entity!.label).toBe('Trupp 2')
  })

  it('three loose chips dropped at once on the Karte: the first minted keeps «Trupp 1»', () => {
    const objs = [
      chip('trupp1758794400020-01xyz', 'Trupp 1'),
      chip('trupp1758794400010-01abc', 'Trupp 1'),
      chip('trupp1758794400030-01def', 'Trupp 1'),
      chip('fz', 'TLF'), // not a Trupp at all
    ]
    const r = resolveTruppNumbers([], objs)!
    expect(r.objects.map(labelOf)).toEqual(['Trupp 2', 'Trupp 1', 'Trupp 3', 'TLF'])
    expect(r.objects[3]).toBe(objs[3]) // untouched objects keep their identity
  })

  it('a sheet chip is relabelled on BOTH bodies — the sheet anno and its baked Karte marker', () => {
    const r = resolveTruppNumbers([], [chip('trupp1758794400010-01a', 'Trupp 4'), sheetChip('t1758794400020-01b', 'Trupp 4')])!
    const moved = r.objects[1]
    expect(moved.sheet!.anno.text).toBe('Trupp 5')
    expect(moved.entity!.label).toBe('Trupp 5')
  })

  it('a chip bound to a Trupp is that Trupp\'s marker and never a claimant of its own', () => {
    expect(resolveTruppNumbers([trupp('tr', 1, '2026-09-25T10:00:00Z')], [chip('m', 'Trupp 1', 'tr')])).toBeNull()
  })

  it('an unnumbered legacy Trupp is left to the load normaliser (workspace · numberTrupps)', () => {
    expect(resolveTruppNumbers([trupp('a', undefined, '2026-09-25T10:00:00Z'), trupp('b', undefined, '2026-09-25T10:00:01Z')], [])).toBeNull()
  })

  it('is settled: resolving the result again changes nothing (no ping-pong)', () => {
    const r = resolveTruppNumbers(
      [trupp('a', 1, '2026-09-25T10:00:00.010Z'), trupp('b', 1, '2026-09-25T10:00:00.020Z'), trupp('c', 2, '2026-09-25T10:00:00.030Z')],
      [chip('trupp1758794400000-01x', 'Trupp 2')],
    )!
    expect(resolveTruppNumbers(r.trupps, r.objects)).toBeNull()
  })
})

describe('truppRenumberings — what a device that showed the old number has to say', () => {
  it('reports a Trupp whose number changed, with its crew as it stands now', () => {
    const before = { trupps: [trupp('a', 1, '2026-09-25T10:00:00Z')] }
    const after = { trupps: [{ ...trupp('a', 3, '2026-09-25T10:00:00Z'), members: ['Müller Hans'] }, trupp('b', 1, '2026-09-25T09:59:59Z')] }
    const r = truppRenumberings(before, after)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'trupp', id: 'a', from: 1, to: 3 })
    expect(r[0].trupp!.members).toEqual(['Müller Hans'])
  })

  it('reports nothing for a Trupp that is new here, or was unnumbered before', () => {
    expect(truppRenumberings({ trupps: [] }, { trupps: [trupp('a', 1, '2026-09-25T10:00:00Z')] })).toEqual([])
    expect(truppRenumberings({ trupps: [trupp('a', undefined, 'x')] }, { trupps: [trupp('a', 4, 'x')] })).toEqual([])
  })

  it('reports a chip that lost its number — but not a chip somebody renamed by hand', () => {
    const lost = { before: chip('c1', 'Trupp 1'), after: chip('c1', 'Trupp 2') }
    const keeper = chip('c0', 'Trupp 1')
    expect(truppRenumberings({ objects: [keeper, lost.before] }, { objects: [keeper, lost.after] }))
      .toEqual([{ kind: 'chip', id: 'c1', from: 1, to: 2 }])
    // «Trupp 2» renamed to «Trupp 5» on another device: nobody holds 2 afterwards — a rename
    expect(truppRenumberings({ objects: [chip('c1', 'Trupp 2')] }, { objects: [chip('c1', 'Trupp 5')] })).toEqual([])
    // …and a chip renamed to a word is not numbered any more at all
    expect(truppRenumberings({ objects: [keeper, chip('c1', 'Trupp 1')] }, { objects: [keeper, chip('c1', 'Angriff')] })).toEqual([])
  })

  it('reads a malformed blob as empty rather than throwing', () => {
    expect(truppRenumberings({ trupps: {} as unknown, objects: 'x' as unknown }, {})).toEqual([])
  })
})

describe('renumberRow — the one Verlauf row', () => {
  it('names the Trupp by its OLD number and whole crew, through truppLogName', () => {
    const t = { ...trupp('tr1', 3, '2026-09-25T10:00:00Z'), name: 'Meier Anna', members: ['Müller Hans'] }
    const row = renumberRow({ kind: 'trupp', id: 'tr1', from: 1, to: 3, trupp: t }, '2026-09-25T10:00:04.000Z')
    expect(row).toMatchObject({
      id: 'trn-tr1-1-3', kind: 'team', subjectId: 'tr1', at: '2026-09-25T10:00:04.000Z',
      text: 'Trupp 1 (Meier Anna / Müller Hans) heisst jetzt Trupp 3',
    })
  })

  it('the id is derived from the change alone — two devices write the same row', () => {
    const c = { kind: 'chip' as const, id: 'trupp1758', from: 1, to: 2 }
    expect(renumberRow(c, '2026-09-25T10:00:04Z').id).toBe(renumberRow(c, '2026-09-25T10:00:09Z').id)
  })
})
