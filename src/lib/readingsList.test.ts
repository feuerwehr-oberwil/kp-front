import { describe, expect, it } from 'vitest'
import { measuredPoints } from './readingsList'
import type { TacticalObject } from './tacticalObjects'
import type { BoardAnno, Entity } from '../types'

/* The «Messungen» list (27.10.2026): every Messpunkt, wherever it was placed, worst first, with
 * a place tag – a point outside the building used to be in no list at all. */

const ent = (id: string, over: Partial<Entity> = {}): Entity =>
  ({ id, kind: 'symbol', layer: 'taktisch', coord: [7.55, 47.51], symbol: 'FW Messpunkt', ...over })
const anno = (id: string, over: Partial<BoardAnno> = {}): BoardAnno =>
  ({ id, kind: 'symbol', x: 0.2, y: 0.7, symbol: 'FW Messpunkt', ...over })
const onMap = (e: Entity): TacticalObject => ({ id: e.id, entity: e })
const onSheet = (planId: string, a: BoardAnno): TacticalObject => ({ id: a.id, sheet: { planId, anno: a } })
const names = { plan: (id: string) => ({ modul2: 'M2/3' })[id] ?? id, storey: (f: number) => `S${f}`, karte: 'Karte' }

describe('measuredPoints — the «Messungen» list', () => {
  it('lists Karte, Gebäude and Modul points with their place, worst first', () => {
    const objects = [
      onMap(ent('hof', { fields: { CO: '12' } })),
      onSheet('gebaeude', anno('z21', { floor: 2, fields: { CO: '65' } })),
      onSheet('modul2', anno('tg', { fields: { Ex: '12' } })),
      onMap(ent('keller')),
    ]
    const list = measuredPoints(objects, names)
    expect(list.map((p) => [p.id, p.where])).toEqual([
      ['z21', 'S2'], ['tg', 'M2/3'], ['hof', 'Karte'], ['keller', 'Karte'],
    ])
    expect(list[0].at).toEqual({ surface: 'plan', planId: 'gebaeude', x: 0.2, y: 0.7, floor: 2 })
    expect(list[2].at).toEqual({ surface: 'map' })
  })

  it('names the storey of a Karte point that has one', () => {
    const [p, q] = measuredPoints([
      onMap(ent('m', { floor: -1, fields: { CO: '3' } })),
      onMap(ent('n', { floorFrom: 0, fields: { CO: '2' } })),
    ], names)
    expect([p.where, q.where]).toEqual(['Karte · S-1', 'Karte · S0'])
  })

  it('skips everything that is not a measured symbol', () => {
    const objects = [onMap(ent('feuer', { symbol: 'VKF Feuer' })), onMap(ent('n', { kind: 'note' }))]
    expect(measuredPoints(objects, names)).toEqual([])
  })
})
