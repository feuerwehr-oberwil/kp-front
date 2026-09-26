import { describe, expect, it } from 'vitest'
import { canonicalJson, jsonEqual } from './jsonEqual'
import { serverRoundTrip } from './jsonb.test-utils'

describe('jsonEqual — JSON equality without key order', () => {
  const shift = { id: 'sh1', personId: 'p1', from: '2026-09-25T17:00:00Z', to: '2026-09-25T19:00:00Z', meta: { b: 1, a: [{ y: 2, x: 1 }] } }

  it('calls a value and its server round trip equal, at every depth', () => {
    const back = serverRoundTrip(shift)
    expect(JSON.stringify(back)).not.toBe(JSON.stringify(shift)) // the round trip did re-sort
    expect(jsonEqual(shift, back)).toBe(true)
    expect(jsonEqual(back, shift)).toBe(true)
  })

  it('still sees every real difference', () => {
    expect(jsonEqual(shift, { ...shift, to: '2026-09-25T21:00:00Z' })).toBe(false)
    expect(jsonEqual(shift, { ...shift, extra: 1 })).toBe(false)
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false)
    expect(jsonEqual([1, 2], [2, 1])).toBe(false) // arrays keep their order
    expect(jsonEqual([1], [1, 1])).toBe(false)
    expect(jsonEqual({ a: [] }, { a: {} })).toBe(false)
    expect(jsonEqual(null, {})).toBe(false)
    expect(jsonEqual('1', 1)).toBe(false)
    expect(jsonEqual(undefined, null)).toBe(false)
  })

  it('agrees with JSON.stringify on what JSON cannot tell apart', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true) // an undefined key is an absent key
    expect(jsonEqual([undefined], [null])).toBe(true) // …and an undefined slot is null
    expect(jsonEqual({ n: NaN }, { n: null })).toBe(true)
    expect(jsonEqual(new Date('2026-09-25T17:00:00Z'), '2026-09-25T17:00:00.000Z')).toBe(true)
  })
})

describe('canonicalJson — one string per value', () => {
  it('writes a value and its server round trip the same', () => {
    const v = { id: 'x', status: 'present', intervals: [{ to: 'b', from: 'a' }] }
    expect(canonicalJson(serverRoundTrip(v))).toBe(canonicalJson(v))
    expect(canonicalJson(serverRoundTrip(v, 'alphabetical'))).toBe(canonicalJson(v))
    expect(canonicalJson({ ...v, status: 'left' })).not.toBe(canonicalJson(v))
  })
})
