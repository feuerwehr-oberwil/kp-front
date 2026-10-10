import { describe, expect, it } from 'vitest'
import { compareOrder, isOrderKey, keyBetween, keysFor } from './orderKey'

describe('order keys', () => {
  it('a key between two is strictly between, and well-formed', () => {
    const pairs: [string | null, string | null][] = [[null, null], [null, 'V'], ['V', null], ['V', 'W'], ['V', 'V1'], ['zz', null], ['a', 'a01']]
    for (const [a, b] of pairs) {
      const k = keyBetween(a, b)
      if (a) expect(k > a).toBe(true)
      if (b) expect(k < b).toBe(true)
      expect(isOrderKey(k)).toBe(true)
    }
  })
  it('two hundred inserts at one spot stay ordered and short', () => {
    let lo = keyBetween(null, null), hi = keyBetween(lo, null)
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi)
      expect(lo < k && k < hi).toBe(true)
      if (i % 2) lo = k; else hi = k
    }
    expect(hi.length).toBeLessThanOrEqual(64)
  })
  it('appending stays ordered', () => {
    const keys = keysFor(200)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(200)
    expect(keysFor(5)).toEqual([...keysFor(5)].sort())
  })
  it('two entries with one key (two devices appended at once) keep a fixed order by id', () => {
    const a = { id: 'b', ord: 'V' }, b = { id: 'a', ord: 'V' }
    expect([a, b].sort(compareOrder).map((x) => x.id)).toEqual(['a', 'b'])
    expect(keyBetween('V', 'V') > 'V').toBe(true)
  })
})
