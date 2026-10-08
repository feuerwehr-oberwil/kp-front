// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { markTafelUsed, OBJECT_SUGGEST_M, startSuggestion, tafelStartVisible, tafelUsed, TAFEL_ID } from './tafelStart'
import type { BoardAnno } from '../types'

function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage,
  })
}

describe('the «Vorschlag» badge on the starter cards', () => {
  it('goes to «Objekt wählen» when an object lies within ~100 m', () => {
    expect(startSuggestion({ distanceM: 40 }, true)).toBe('object')
    expect(startSuggestion({ distanceM: OBJECT_SUGGEST_M }, false)).toBe('object')
  })
  it('…or when the server matched the object by address, whatever the distance says', () => {
    expect(startSuggestion({ distanceM: 400, addressMatch: true }, true)).toBe('object')
  })
  it('goes to «Gebäude am Einsatzort» when the nearest object is further and the Einsatz has a location', () => {
    expect(startSuggestion({ distanceM: 101 }, true)).toBe('building')
    expect(startSuggestion({ distanceM: null }, true)).toBe('building')
    expect(startSuggestion(null, true)).toBe('building')
  })
  it('goes nowhere without a near object and without a location', () => {
    expect(startSuggestion({ distanceM: 900 }, false)).toBeNull()
    expect(startSuggestion(null, false)).toBeNull()
  })
})

describe('when the starter cards stand on the Tafel', () => {
  const base = { planId: TAFEL_ID, annos: [] as BoardAnno[], everUsed: false, readOnly: false, dismissed: false }
  const note: BoardAnno = { id: 't1', kind: 'text', x: 0.5, y: 0.5, text: 'Zugang' }

  it('only on the empty Tafel of an Einsatz this device has never seen hold anything', () => {
    expect(tafelStartVisible(base)).toBe(true)
    expect(tafelStartVisible({ ...base, planId: 'modul1' })).toBe(false)
    expect(tafelStartVisible({ ...base, annos: [note] })).toBe(false)
  })
  it('never on a read-only sheet, and not while a tool is armed (drawing hides them)', () => {
    expect(tafelStartVisible({ ...base, readOnly: true })).toBe(false)
    expect(tafelStartVisible({ ...base, dismissed: true })).toBe(false)
  })

  describe('the return rule', () => {
    beforeEach(installLocalStorage)

    it('a delete-all (and its ↶) never brings them back: the first object remembers the Einsatz', () => {
      expect(tafelUsed('inc1')).toBe(false)
      // something was drawn — the whiteboard marks the Einsatz
      markTafelUsed('inc1')
      // …then everything was deleted: the sheet is empty again, the cards stay away
      expect(tafelStartVisible({ ...base, everUsed: tafelUsed('inc1') })).toBe(false)
      // another Einsatz is untouched
      expect(tafelUsed('inc2')).toBe(false)
    })
    it('keeps a bounded list and tolerates a missing id', () => {
      for (let i = 0; i < 120; i++) markTafelUsed(`i${i}`)
      expect(tafelUsed('i119')).toBe(true)
      expect(tafelUsed('i0')).toBe(false)
      markTafelUsed(undefined)
      expect(tafelUsed(undefined)).toBe(false)
    })
  })
})
