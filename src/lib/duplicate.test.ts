import { describe, expect, it } from 'vitest'
import { DUP_OFFSET, duplicateDrawing, duplicateEntity } from './duplicate'
import type { Drawing, Entity } from '../types'

describe('⌘D copies on the Karte', () => {
  it('a symbol keeps every property, takes the new id and moves one nudge east and south', () => {
    const src = { id: 'p1', kind: 'symbol', symbol: 'VKF Fahrzeug', coord: [7.6, 47.5], rotation: 30, label: 'TLF' } as Entity
    const copy = duplicateEntity(src, 'p2')
    expect(copy).toEqual({ ...src, id: 'p2', coord: [7.6 + DUP_OFFSET, 47.5 - DUP_OFFSET] })
    expect(src.coord).toEqual([7.6, 47.5]) // the original is untouched
  })

  it('a copy of an «erledigt» symbol is a new, active one — `done` is not copied', () => {
    const src = { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', coord: [7.6, 47.5], done: { at: '2026-09-23T18:40:00.000Z' } } as Entity
    const copy = duplicateEntity(src, 'f2')
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
