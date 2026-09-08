import { describe, expect, it } from 'vitest'
import './pdfPolyfills'

// Regression (08.09.): pdf.js v6.2 calls these unguarded in BOTH bundles and Samsung
// Internet lacks them (~Chrome 141/140 APIs) — «f(...).getOrInsertComputed is not a
// function» broke every PDF on a current Samsung phone. The polyfill must leave a working,
// spec-shaped method behind whether or not the engine ships its own.

type UpsertMap<K, V> = Map<K, V> & {
  getOrInsert(key: K, value: V): V
  getOrInsertComputed(key: K, compute: (key: K) => V): V
}

describe('pdfPolyfills — the upsert pair pdf.js hard-depends on', () => {
  it('getOrInsertComputed computes once and returns the held value afterwards', () => {
    const m = new Map<string, number[]>() as UpsertMap<string, number[]>
    let computed = 0
    const first = m.getOrInsertComputed('k', () => { computed += 1; return [] })
    first.push(1)
    const second = m.getOrInsertComputed('k', () => { computed += 1; return [] })
    expect(second).toBe(first)
    expect(computed).toBe(1)
  })

  it('getOrInsert keeps an existing value and inserts the default otherwise', () => {
    const m = new Map<string, string>() as UpsertMap<string, string>
    expect(m.getOrInsert('a', 'x')).toBe('x')
    expect(m.getOrInsert('a', 'y')).toBe('x')
  })

  it('WeakMap carries the pair too', () => {
    const m = new WeakMap<object, string>() as WeakMap<object, string> & {
      getOrInsertComputed(key: object, compute: (key: object) => string): string
    }
    const k = {}
    expect(m.getOrInsertComputed(k, () => 'v')).toBe('v')
    expect(m.getOrInsertComputed(k, () => 'other')).toBe('v')
  })

  it('Uint8Array to/from base64 round-trips (the signature-annotation path)', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255])
    const U8 = Uint8Array as unknown as { fromBase64(s: string): Uint8Array }
    const b64 = (bytes as unknown as { toBase64(): string }).toBase64()
    expect(Array.from(U8.fromBase64(b64))).toEqual([0, 1, 127, 128, 255])
  })
})
