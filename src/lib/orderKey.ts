/**
 * Sortable order keys — fractional indexing over base-62 digits (10.10.2026, board reorder).
 *
 * A list whose entries can be moved by hand on several devices at once keeps its order as one
 * string per entry, compared as plain strings (`<`): a move or an insert writes ONE key — the
 * moved entry's — between its new neighbours, and nothing else in the list changes. Two devices
 * reordering different entries therefore merge without touching each other, and the result is
 * the same on every device. Two devices that append at the end at once mint the same key; the
 * entry id breaks that tie (`compareOrder`), so both are kept, in a fixed order.
 *
 * Keys never end in the lowest digit, so there is always room between two of them.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZERO = DIGITS[0]

/** A string strictly between `a` (or nothing) and `b` (or nothing), `a < b`. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`order key: ${a} >= ${b}`)
  if (b) {
    // the shared prefix stays; the rest is split below it
    let n = 0
    while ((a[n] ?? ZERO) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  // neighbouring digits: one more digit
  if (b && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

/** A key between two keys (`null` = the start / the end of the list). */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a ?? '', hi = b ?? null
  if (hi !== null && lo >= hi) {
    // two entries already share a key (two devices appended at once): go just after `a`
    return midpoint(lo, null)
  }
  return midpoint(lo, hi)
}

/** `n` keys in order for a list that has none yet (a page from before order keys). */
export function keysFor(n: number): string[] {
  if (n < DIGITS.length - 1) {
    // evenly spaced single digits: room before, between and after
    return Array.from({ length: n }, (_, i) => DIGITS[Math.round(((i + 1) * DIGITS.length) / (n + 1))])
  }
  const out: string[] = []
  let last: string | null = null
  for (let i = 0; i < n; i++) { last = keyBetween(last, null); out.push(last) }
  return out
}

/** A well-formed key: base-62 digits, not ending in the lowest one, not absurdly long (each bisection at one spot costs ~6 bits: 200 moves into one gap ≈ 35 chars). */
export const isOrderKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256 && [...v].every((c) => DIGITS.includes(c)) && !v.endsWith(ZERO)

/** Entry order: by key, then by id (two equal keys — two devices appended at once). */
export function compareOrder(a: { ord?: string; id: string }, b: { ord?: string; id: string }): number {
  const x = a.ord ?? '', y = b.ord ?? ''
  if (x !== y) return x < y ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
