// What the server's Postgres JSONB does to the blob on the way through: every object comes back
// with its keys RE-SORTED — shorter keys first, then bytewise — recursively, arrays kept in order.
// `alphabetical` is there so the tests do not depend on that exact rule, only on «a different
// order than the code built».

export type KeyOrder = 'jsonb' | 'alphabetical'

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const ORDERS: Record<KeyOrder, (a: string, b: string) => number> = {
  jsonb: (a, b) => a.length - b.length || byteOrder(a, b),
  alphabetical: byteOrder,
}

/** `v` as it reads after a round trip through the server: same data, keys re-sorted. */
export function serverRoundTrip<T>(v: T, order: KeyOrder = 'jsonb'): T {
  const cmp = ORDERS[order]
  const walk = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(walk)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort(cmp).map((k) => [k, walk((x as Record<string, unknown>)[k])]))
        : x
  return walk(v) as T
}
