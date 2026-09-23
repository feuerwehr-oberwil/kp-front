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

// ⚠️ Every SYNCED record goes through `newId`, Verlauf rows included (24.09.2026). The Übung of
// 23.09. ran one editor login on three devices, and the hand-rolled `e${Date.now()}-${seq}` row
// ids met: each device's counter starts at 0, so two rows written in one millisecond on two
// tablets carried the same id — and the server's journal is idempotent BY that id, so it kept
// the first and silently dropped the second (backend · journal.append_rows). Same for Mittel
// events (merged by id: two materials became one), patch rows, Trupps, board objects, Gäste,
// Pendenzen and the poster's rows. Ids already stored keep their old shape; nothing rewrites them.

/** What wrote a Verlauf row, where it matters to a reader: `j` the composer, `v` a voice memo,
 *  `p` an entry made in the audio player (the only rows the player may retract). */
export type RowTag = 'j' | 'v' | 'p'

/** A Verlauf row id: `e<ms>-<seq><rand>`, with the tag after one more dash (`…-p`). */
export function newRowId(tag?: RowTag): string {
  return tag ? `${newId('e')}-${tag}` : newId('e')
}

/**
 * Whether a row was written by the audio player (`newRowId('p')`) — both shapes.
 *
 * ⚠️ The legacy shape is `e<ms>-p<n>` with `n` the player's per-session counter, and it is
 * matched on at most THREE digits on purpose: a plain `newId('e')` tail is five characters
 * (`<seq:2><rand:3>`), so `e<ms>-p1234` is an ordinary row whose counter happened to read `p1`
 * and whose random tail came out all digits. Matching that would offer «Eintrag entfernen» on a
 * log line (about one row in six thousand). The cost is a legacy player row past the
 * 1000th of one session losing its ✕ — it stays editable.
 */
export function isPlayerRowId(id: string): boolean {
  return /^e\d+-(?:p\d{1,3}|[0-9a-z]+-p)$/.test(id)
}
