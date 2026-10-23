import { describe, expect, it } from 'vitest'
import { incidentPrefStore, type PrefStorage } from './incidentPrefStore'

const memStorage = (): PrefStorage & { raw: Map<string, string> } => {
  const raw = new Map<string, string>()
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => { raw.set(k, v) },
    removeItem: (k) => { raw.delete(k) },
  }
}

const words = (storage: () => PrefStorage) => incidentPrefStore<string[]>({
  key: (id) => `kp.test.${id}`,
  parse: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined),
  storage,
})

describe('incidentPrefStore', () => {
  it('round-trips per incident, and one incident never answers for another', () => {
    const mem = memStorage()
    const store = words(() => mem)
    store.write('inc1', ['a', 'b'])
    store.write('inc2', ['c'])
    expect(mem.raw.get('kp.test.inc1')).toBe('["a","b"]')
    expect(store.read('inc1')).toEqual(['a', 'b'])
    expect(store.read('inc3')).toBeUndefined()

    store.clear('inc1')
    expect(store.read('inc1')).toBeUndefined()
    expect(store.read('inc2')).toEqual(['c'])
  })

  it('reads «never said» on a corrupt or refused value, and never throws without storage', () => {
    const mem = memStorage()
    const store = words(() => mem)
    mem.raw.set('kp.test.inc1', '{ not json')
    expect(store.read('inc1')).toBeUndefined()
    mem.raw.set('kp.test.inc1', '[1, 2]')
    expect(store.read('inc1')).toBeUndefined()

    // storage disabled (private mode, no Web Storage at all): a miss, and writes are dropped
    const none = words(() => { throw new Error('SecurityError') })
    expect(none.read('inc1')).toBeUndefined()
    expect(() => { none.write('inc1', ['a']); none.clear('inc1') }).not.toThrow()
  })
})
