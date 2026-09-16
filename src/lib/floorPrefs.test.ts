import { describe, it, expect, beforeEach } from 'vitest'
import { loadHiddenFloors, saveHiddenFloors, shownFloors } from './floorPrefs'

// Same stand-in as layerPrefs.test: the suite runs in the node environment, which has no Web
// Storage, and this module only ever touches these three methods.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  },
})

describe('floorPrefs — folding a Geschoss away is device-local', () => {
  beforeEach(() => store.clear())

  it('round-trips per incident, and one incident never answers for another', () => {
    saveHiddenFloors('inc1', [2, -1])
    expect(loadHiddenFloors('inc1')).toEqual([2, -1])
    expect(loadHiddenFloors('inc2')).toEqual([])
  })

  it('shows everything again rather than opening a broken stack on a corrupt value', () => {
    store.set('kp.floors.hidden.inc1', '{ not json')
    expect(loadHiddenFloors('inc1')).toEqual([])
    store.set('kp.floors.hidden.inc1', '[0, "EG", null]')
    expect(loadHiddenFloors('inc1')).toEqual([0]) // the storey survives, the noise does not
  })

  it('forgets the key entirely once nothing is hidden', () => {
    saveHiddenFloors('inc1', [1])
    saveHiddenFloors('inc1', [])
    expect(store.has('kp.floors.hidden.inc1')).toBe(false)
  })
})

describe('shownFloors', () => {
  it('drops what is hidden and keeps the order it was given', () => {
    expect(shownFloors([2, 1, 0, -1], [2, -1])).toEqual([1, 0])
  })

  // ⚠️ the guard that keeps the board from becoming a stack with no tiles — and no way back
  it('never returns an empty stack', () => {
    expect(shownFloors([1, 0], [1, 0])).toEqual([1, 0])
  })

  it('shows a storey the pack gained since this device last looked', () => {
    expect(shownFloors([3, 2, 1, 0], [2])).toEqual([3, 1, 0])
  })
})
