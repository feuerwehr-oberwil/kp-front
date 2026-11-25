import { describe, expect, it } from 'vitest'
import { storeStepWords } from './undoStepWords'
import type { TacticalObject } from './tacticalObjects'
import type { Drawing, Entity } from '../types'

const ent = (id: string, over: Partial<Entity> = {}): TacticalObject =>
  ({ id, entity: { id, kind: 'symbol', layer: 'ops', coord: [7.5, 47.5], symbol: 'tlf', label: 'TLF', ...over } as Entity })
const line = (id: string, coords: Drawing['coords']): TacticalObject =>
  ({ id, drawing: { id, kind: 'line', coords, label: 'Zuleitung' } as Drawing })

// owner pick UX journeys M·11 (25.11.2026): the ↶ names the object a Karte step changed
describe('storeStepWords', () => {
  const tlf = ent('a')
  const feuer = ent('b', { label: 'Feuer' })
  it('names what happened to the ONE object the step changed', () => {
    expect(storeStepWords([tlf, feuer], [ent('a', { coord: [7.6, 47.5] }), feuer])).toEqual({ id: 'a', text: 'TLF verschoben', drawing: false })
    expect(storeStepWords([feuer], [feuer, tlf])).toEqual({ id: 'a', text: 'TLF gesetzt', drawing: false })
    expect(storeStepWords([tlf, feuer], [feuer])).toEqual({ id: 'a', text: 'TLF entfernt', drawing: false })
    expect(storeStepWords([tlf], [ent('a', { label: 'TLF 2' })])).toEqual({ id: 'a', text: 'TLF 2 geändert', drawing: false })
    expect(storeStepWords([line('l', [[1, 1], [2, 2]])], [line('l', [[1, 1], [3, 3]])])).toEqual({ id: 'l', text: 'Zuleitung verschoben', drawing: true })
  })
  it('says a Notiz is a Notiz, not its text', () => {
    expect(storeStepWords([], [ent('n', { kind: 'note', label: 'Wasser bei Hydrant 3', symbol: undefined })])?.text).toBe('Notiz gesetzt')
  })
  it('keeps the domain word when the step changed several objects, or none', () => {
    expect(storeStepWords([tlf, feuer], [ent('a', { coord: [0, 0] }), ent('b', { coord: [0, 0] })])).toBeNull()
    expect(storeStepWords([tlf], [tlf])).toBeNull()
  })
})
