import { describe, it, expect, beforeEach } from 'vitest'
import { foldedStoreyTeams, loadHiddenFloors, saveHiddenFloors, shownFloors, storeysToReveal, type StoreyTeam } from './floorPrefs'

// The per-incident round trip is lib/incidentPrefStore's (incidentPrefStore.test); here: the
// hidden set's own parsing and the «never empty» guard.
//
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

  it('shows everything again rather than opening a broken stack on a corrupt value', () => {
    store.set('kp.floors.hidden.inc1', '{ not json')
    expect(loadHiddenFloors('inc1')).toEqual([])
    store.set('kp.floors.hidden.inc1', '[0, "EG", null]')
    expect(loadHiddenFloors('inc1')).toEqual([0]) // the storey survives, the noise does not
  })

  it('stores the hidden set as plain JSON, and forgets the key entirely once nothing is hidden', () => {
    saveHiddenFloors('inc1', [1, -1])
    expect(store.get('kp.floors.hidden.inc1')).toBe('[1,-1]') // the on-device format
    expect(loadHiddenFloors('inc1')).toEqual([1, -1])
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

describe('the folded storey and the Trupps on it (M7, F4)', () => {
  const T = (id: string, floor: number, tone: StoreyTeam['tone'] = null): StoreyTeam => ({ id, floor, name: id, tone })

  it('lists the Trupps per folded storey, the one in most trouble first', () => {
    const m = foldedStoreyTeams([T('a', 2), T('b', 2, 'crit'), T('c', 1), T('d', 2, 'warn')], [2])
    expect([...m.keys()]).toEqual([2])
    expect(m.get(2)!.map((t) => t.id)).toEqual(['b', 'd', 'a'])
  })

  it('unfolds for a Trupp set onto, or moved onto, a folded storey – and for one whose alarm goes critical there', () => {
    const before = new Map([['a', { floor: 2, tone: null }], ['b', { floor: 1, tone: null }], ['c', { floor: 3, tone: 'warn' as const }]])
    expect(storeysToReveal(before, [T('a', 2), T('b', 1), T('c', 3)], [2, 3])).toEqual([])
    expect(storeysToReveal(before, [T('a', 2), T('b', 1), T('c', 3), T('new', 3)], [2, 3])).toEqual([3])
    expect(storeysToReveal(before, [T('a', 2), T('b', 2), T('c', 3)], [2, 3])).toEqual([2])
    expect(storeysToReveal(before, [T('a', 2), T('b', 1), T('c', 3, 'crit')], [2, 3])).toEqual([3])
  })

  it('keeps a fold made over a Trupp already there, even an overdue one, and only seeds on the first look', () => {
    const before = new Map([['a', { floor: 2, tone: 'crit' as const }]])
    expect(storeysToReveal(before, [T('a', 2, 'crit')], [2])).toEqual([])
    expect(storeysToReveal(null, [T('a', 2, 'crit'), T('b', 2)], [2])).toEqual([])
  })
})
