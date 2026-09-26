// JSON comparison that does not read KEY ORDER as a difference.
//
// ⚠️ Why this exists (staging r3 F11, 25.09.2026). The server keeps the workspace blob as
// Postgres JSONB, and JSONB hands every object back with its keys re-sorted (shorter keys
// first, then bytewise) — while the objects this device builds keep the order the code wrote
// them in. `JSON.stringify(a) === JSON.stringify(b)` therefore called two identical entries
// different. In the three-way merge that is data loss, not noise: an entry this device never
// touched read as «changed here» against its server-sorted ancestor, so when another device
// really changed it, «both changed» went last-writer-wins to THIS device's stale copy and the
// other device's edit was dropped (Zeitplan shifts, every whole-object collection). In the
// Anwesenheit it raised «abweichende Angaben zusammengeführt – bitte prüfen» with two
// identical sides.
//
// Every comparison that can meet a value the server sent back goes through here.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** What JSON.stringify leaves out of an object (and writes as `null` in an array). */
const dropped = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol'

/** A value as JSON writes it: a non-finite number is `null`, a `toJSON` (a Date) is applied. */
const asJson = (v: unknown): unknown =>
  typeof v === 'number' ? (Number.isFinite(v) ? v : null)
    : isObj(v) && typeof v.toJSON === 'function' ? (v.toJSON as () => unknown)()
      : v

/**
 * `JSON.stringify(a) === JSON.stringify(b)`, except that the order of an object's keys does not
 * count. Arrays compare in order; an `undefined` object value is the same as an absent key and an
 * `undefined` array slot the same as `null` (JSON writes them so).
 *
 * Identity first, so an untouched slice (the same object on both sides) costs nothing.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  a = asJson(a)
  b = asJson(b)
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(dropped(a[i]) ? null : a[i], dropped(b[i]) ? null : b[i])) return false
    }
    return true
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => !dropped(a[k]))
    const kb = Object.keys(b).filter((k) => !dropped(b[k]))
    if (ka.length !== kb.length) return false
    return ka.every((k) => !dropped(b[k]) && Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

/**
 * JSON.stringify with every object's keys SORTED — one string per value, whatever order its keys
 * were built or stored in. For identities derived from a value (a divergence's signature, which
 * two devices must compute alike from one side built locally and one read off the server).
 */
export function canonicalJson(v: unknown): string | undefined {
  return JSON.stringify(v, (_k, x: unknown) =>
    isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
}
