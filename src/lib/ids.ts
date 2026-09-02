// Ids for records the app mints locally (a drawing, a shift, a Trupp) and then syncs.
//
// The house shape has always been `prefix + Date.now()`, and for most of them that is fine
// because nothing can produce two in the same millisecond. For the ones that can it is not:
// two finished lines inside one millisecond — a tap-away auto-commit landing next to a
// freehand stroke — mint the SAME id, and the merge treats them as one record. Worse, the
// document is per-incident and shared: two tablets drawing at the same moment collide by
// construction, and neither ever learns it dropped the other's shape.

/** Wraps at 36² — long before two ids minted in one millisecond could meet the same value. */
let seq = 0

/**
 * A locally minted record id: `<prefix><ms>-<seq><random>`, e.g. `d1758038400123-0kf9`.
 *
 * Same shape and family as the hand-rolled `prefix + Date.now()` it replaces (URL- and
 * storage-safe, sortable by the timestamp, six characters longer). The counter keeps two
 * mints in one tab apart; the random tail keeps two DEVICES apart, which a counter cannot.
 */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1296
  return `${prefix}${Date.now()}-${seq.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`
}
