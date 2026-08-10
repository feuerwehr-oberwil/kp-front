import { describe, expect, it } from 'vitest'
import { entityEditChanges, entityLogName } from './entityEdit'
import type { Entity } from '../types'

const sym = (over: Partial<Entity>): Entity => ({
  id: 'e1', kind: 'symbol', layer: 'taktisch', coord: [7.5, 47.4], symbol: 'Einsatzleiter', ...over,
})

// The Kroki is the picture the Einsatz is led from. It used to earn a Verlauf row when a symbol
// appeared and when it went, and nothing for the two hours in between during which it changed.
describe('entityEditChanges (the Verlauf line for editing the Kroki)', () => {
  it('names the field AND the value that was typed into it', () => {
    const prev = sym({ fields: {} })
    expect(entityEditChanges(prev, sym({ fields: { Name: 'Widmer Céline' } })))
      .toEqual(['Name: Widmer Céline'])
  })

  it('says a field was CHANGED when it already said something else', () => {
    const prev = sym({ fields: { Name: 'Meier Hans' } })
    expect(entityEditChanges(prev, sym({ fields: { Name: 'Widmer Céline' } })))
      .toEqual(['Name auf Widmer Céline geändert'])
  })

  it('reports a cleared field as cleared, not as an empty value', () => {
    const prev = sym({ fields: { Name: 'Meier Hans' } })
    expect(entityEditChanges(prev, sym({ fields: { Name: '  ' } }))).toEqual(['Name geleert'])
  })

  it('names the Stockwerk it turned out to be on', () => {
    expect(entityEditChanges(sym({}), sym({ floor: 2 }))).toEqual(['Stockwerk 2. OG'])
    expect(entityEditChanges(sym({ floor: 2 }), sym({}))).toEqual(['Stockwerk entfernt'])
  })

  it('carries a Stockwerk range — what a Treppe or a Lift covers', () => {
    expect(entityEditChanges(sym({}), sym({ floorFrom: -1, floorTo: 3 })))
      .toEqual(['Stockwerke 1. UG – 3. OG'])
  })

  it('counts, and treats an absent count as one', () => {
    expect(entityEditChanges(sym({}), sym({ count: 3 }))).toEqual(['Anzahl 3'])
    expect(entityEditChanges(sym({ count: 1 }), sym({}))).toEqual([])
  })

  it('says a Notiz was written, never what it says — the Verlauf is not a second Kroki', () => {
    const out = entityEditChanges(sym({}), sym({ notes: 'Gasgeruch im Treppenhaus' }))
    expect(out).toEqual(['Notiz erfasst'])
    expect(out.join()).not.toContain('Gasgeruch')
  })

  it('stays silent on pure geometry — arranging the picture is not an event', () => {
    const prev = sym({ coord: [7.5, 47.4], rotation: 0 })
    expect(entityEditChanges(prev, sym({ coord: [7.6, 47.5], rotation: 90, sizeM: 2 }))).toEqual([])
  })

  it('collects several edits into one line, in the order they are read', () => {
    const prev = sym({ fields: {} })
    expect(entityEditChanges(prev, sym({ fields: { Name: 'Widmer Céline' }, floor: 2, count: 3 })))
      .toEqual(['Name: Widmer Céline', 'Stockwerk 2. OG', 'Anzahl 3'])
  })

  it('calls the symbol by its label, falling back to the symbol name', () => {
    expect(entityLogName(sym({ label: 'EL Widmer' }))).toBe('EL Widmer')
    expect(entityLogName(sym({ label: '  ' }))).toBe('Einsatzleiter')
  })
})
