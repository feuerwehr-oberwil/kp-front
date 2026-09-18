import { describe, it, expect } from 'vitest'
import { chooserOffered, markChooserOffered, offerChooser } from './chooserOffer'

/** a localStorage stand-in — the app's own store is not available in the node environment */
function store() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

describe('a group list offers itself once per Einsatz', () => {
  it('offers on the first visit, and not again once marked', () => {
    const s = store()
    expect(offerChooser({ group: 'plans', incidentId: 'i1', many: true, store: s })).toBe(true)
    markChooserOffered('plans', 'i1', s)
    expect(chooserOffered('plans', 'i1', s)).toBe(true)
    expect(offerChooser({ group: 'plans', incidentId: 'i1', many: true, store: s })).toBe(false)
  })

  // The whole point: tonight's alarm has other plans than last week's Übung.
  it('offers again for a different Einsatz', () => {
    const s = store()
    markChooserOffered('plans', 'i1', s)
    expect(offerChooser({ group: 'plans', incidentId: 'i2', many: true, store: s })).toBe(true)
  })

  it('never offers a list of one', () =>
    expect(offerChooser({ group: 'plans', incidentId: 'i1', many: false, store: store() })).toBe(false))

  it('never offers without an Einsatz to remember it for', () =>
    expect(offerChooser({ group: 'plans', incidentId: undefined, many: true, store: store() })).toBe(false))

  // private mode: a store that throws must not take the tile down with it
  it('survives a store that throws', () => {
    const s = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(offerChooser({ group: 'plans', incidentId: 'i9', many: true, store: s })).toBe(true)
    expect(() => markChooserOffered('plans', 'i9', s)).not.toThrow()
    // …and still only once: the slot is held in memory where the box refuses
    expect(offerChooser({ group: 'plans', incidentId: 'i9', many: true, store: s })).toBe(false)
  })
})
