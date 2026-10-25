import { describe, expect, it, vi } from 'vitest'
import { DUP_OFFSET, DUP_OFFSET_N, duplicateAnno, duplicateDrawing, duplicateEntity } from './duplicate'
import type { BoardAnno, Drawing, Entity } from '../types'

describe('⌘D copies on the Karte', () => {
  it('a symbol keeps every property, takes the new id and moves one nudge east and south', () => {
    const src = { id: 'p1', kind: 'symbol', symbol: 'VKF Fahrzeug', coord: [7.6, 47.5], rotation: 30, label: 'TLF' } as Entity
    const copy = duplicateEntity(src, 'p2', () => [])
    expect(copy).toEqual({ ...src, id: 'p2', coord: [7.6 + DUP_OFFSET, 47.5 - DUP_OFFSET] })
    expect(src.coord).toEqual([7.6, 47.5]) // the original is untouched
  })

  it('a copy of an «erledigt» symbol is a new, active one — `done` is not copied', () => {
    const src = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', coord: [7.6, 47.5], done: { at: '2026-09-23T18:40:00.000Z' } } as Entity
    const copy = duplicateEntity(src, 'f2', () => [])
    expect('done' in copy).toBe(false)
    expect(src.done).toBeTruthy() // the original keeps it
  })

  it('a drawing moves every vertex by the same nudge', () => {
    const src = { id: 'd1', kind: 'line', coords: [[7.6, 47.5], [7.7, 47.6]], color: '#f00' } as Drawing
    const copy = duplicateDrawing(src, 'sh1')
    expect(copy.id).toBe('sh1')
    expect(copy.color).toBe('#f00')
    expect(copy.coords).toEqual([[7.6 + DUP_OFFSET, 47.5 - DUP_OFFSET], [7.7 + DUP_OFFSET, 47.6 - DUP_OFFSET]])
  })
})

describe('⌘D copies a loose Trupp under the next number of the one counter', () => {
  it('on the Karte: «Trupp 2» copied beside a «Trupp 3» becomes «Trupp 4»', () => {
    const src = { id: 't1', kind: 'team', coord: [7.6, 47.5], label: 'Trupp 2' } as Entity
    expect(duplicateEntity(src, 't2', () => ['Trupp 2', 'Trupp 3']).label).toBe('Trupp 4')
  })

  it('a chip that IS an Atemschutz-Trupp keeps its name — and never reads the counter', () => {
    const src = { id: 't1', kind: 'team', coord: [7.6, 47.5], label: 'Trupp 2', truppId: 'at1' } as Entity
    const counter = vi.fn(() => ['Trupp 2'])
    expect(duplicateEntity(src, 't2', counter).label).toBe('Trupp 2')
    expect(counter).not.toHaveBeenCalled()
  })
})

describe('⌘D copies on the Plan', () => {
  it('nudges a placed object and every vertex of a stroke by the plan-width step, storeys kept', () => {
    const sym = { id: 's1', kind: 'symbol', x: 0.4, y: 0.5, floor: 1, symbol: 'VKF Feuer' } as BoardAnno
    expect(duplicateAnno(sym, 's2', () => [])).toMatchObject({ id: 's2', x: 0.4 + DUP_OFFSET_N, y: 0.5 + DUP_OFFSET_N, floor: 1 })
    const line = { id: 'l1', kind: 'draw', floor: 2, pts: [[0.1, 0.1], [0.2, 0.2, 3]] } as BoardAnno
    expect(duplicateAnno(line, 'l2', () => []).pts).toEqual([[0.1 + DUP_OFFSET_N, 0.1 + DUP_OFFSET_N, 2], [0.2 + DUP_OFFSET_N, 0.2 + DUP_OFFSET_N, 3]])
  })

  it('drops «erledigt» and the recorded trail, and renumbers a loose chip', () => {
    const chip = { id: 'r1', kind: 'resource', x: 0.5, y: 0.5, text: 'Trupp 1', trail: [{ x: 0.1, y: 0.1, t: '12:00' }], done: { at: '2026-09-23T18:40:00.000Z' } } as BoardAnno
    const copy = duplicateAnno(chip, 'r2', () => ['Trupp 1'])
    expect(copy.trail).toBeUndefined()
    expect('done' in copy).toBe(false)
    expect(copy.text).toBe('Trupp 2')
  })
})
