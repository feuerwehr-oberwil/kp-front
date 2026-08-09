import type { AttendanceEntry, PresenceInterval } from '../types'

/**
 * Presence as a list of executed blocks rather than one span.
 *
 * A person can leave and come back — the Verpflegungsablösung, the second Alarm, the member who
 * drops out at 18:00 and returns at 22:00. The old record could not hold that: it carried a single
 * `checkedInAt`/`leftAt` pair, so a second «anwesend» kept the first arrival AND the stale
 * departure, leaving the person present and abgemeldet at once, with the second block nowhere.
 *
 * `intervals` is now the truth; `checkedInAt`/`leftAt` stay as the DERIVED first arrival and last
 * departure so the rapport, the statistics export and the QR capture sheet keep reading the shape
 * they always read. An entry written before this change simply has no `intervals` and projects its
 * pair — there is no migration, and both shapes stay readable forever.
 *
 * Only EXECUTED presence lives here. Planned shifts (lib/shifts) are a separate collection and
 * never write into this one.
 */

/** Every executed block of an entry, oldest first — legacy pair included, so callers see one shape.
 *
 *  A legacy entry may carry the old half-state: `status: 'present'` WITH a stale `leftAt`, left
 *  behind when a second «anwesend» kept the earlier departure. `status` is the operational truth
 *  there — the person is in the incident — so that projects as one OPEN block and the stale
 *  departure is dropped rather than marking a present member gone. */
export function intervalsOf(e: AttendanceEntry | undefined): PresenceInterval[] {
  if (!e) return []
  if (e.intervals?.length) return e.intervals
  if (!e.checkedInAt) return []
  if (e.status === 'present') return [{ from: e.checkedInAt }]
  return e.leftAt ? [{ from: e.checkedInAt, to: e.leftAt }] : [{ from: e.checkedInAt }]
}

/** True while the person is here: the newest block has no end yet.
 *
 *  For an entry that predates blocks the RECORDED status decides instead — a legacy 'left' row
 *  whose `leftAt` never made it to disk would otherwise read as an open block and put someone who
 *  went home back on the board. */
export function isPresent(e: AttendanceEntry | undefined): boolean {
  if (!e) return false
  if (!e.intervals?.length) return e.status === 'present'
  const list = e.intervals
  return !list[list.length - 1].to
}

/**
 * Rebuild an entry around its blocks, re-deriving the compatibility fields: `checkedInAt` is the
 * first arrival, `leftAt` the last departure — and absent while the person is back, because they
 * have not left. `status` follows the newest block.
 */
export function withIntervals(e: AttendanceEntry, intervals: PresenceInterval[]): AttendanceEntry {
  const last = intervals[intervals.length - 1]
  return {
    ...e,
    status: last && !last.to ? 'present' : 'left',
    checkedInAt: intervals[0]?.from,
    leftAt: last?.to,
    intervals,
  }
}

/**
 * Open a block at `at` — the arrival. A no-op while one is already open, so a double tap can't
 * fragment the record. `at` is the caller's choice: the alarm time for a first tick (ticking often
 * happens long after arrival, and now() would print an end-of-incident «von»), but the real clock
 * for a return, where the alarm time would be nonsense.
 */
export function openPresence(prev: AttendanceEntry | undefined, at: string, displayName: string): AttendanceEntry {
  const base: AttendanceEntry = prev ?? { status: 'present', displayNameSnapshot: displayName }
  const list = intervalsOf(prev)
  if (list.length > 0 && !list[list.length - 1].to) return { ...base, displayNameSnapshot: displayName }
  return withIntervals({ ...base, displayNameSnapshot: displayName }, [...list, { from: at }])
}

/** Close the open block at `at` — the departure. A no-op when nobody is here to leave. */
export function closePresence(prev: AttendanceEntry, at: string, displayName?: string): AttendanceEntry {
  const list = intervalsOf(prev)
  const last = list[list.length - 1]
  if (!last || last.to) return prev
  const next = [...list.slice(0, -1), { ...last, to: at }]
  return withIntervals({ ...prev, ...(displayName ? { displayNameSnapshot: displayName } : {}) }, next)
}

/** Correct one block's start/end — the time chips in Anwesenheit, the Stunden editor, the QR sheet. */
export function setIntervalTime(prev: AttendanceEntry, index: number, patch: { from?: string; to?: string }): AttendanceEntry {
  const list = intervalsOf(prev)
  if (index < 0 || index >= list.length) return prev
  const next = list.map((iv, i) => (i === index ? { ...iv, ...patch } : iv))
  return withIntervals(prev, next)
}

/** Index of the block a correction applies to: the open one, else the last closed one. */
export function currentIntervalIndex(e: AttendanceEntry | undefined): number {
  return Math.max(0, intervalsOf(e).length - 1)
}

/**
 * Blocks separated by less than `gapMin` read as ONE stretch.
 *
 * A crew member who is ticked «gegangen» and «wieder anwesend» a minute later did not leave —
 * somebody corrected a mis-tap, or the QR poster and the tablet recorded the same arrival from
 * two sides. On the Personalblatt that came out as two lines under one name, «22:11 – 22:58»
 * over «22:59 – 23:20», which reads as a person who went home and came back for an Einsatz that
 * never stopped (08.08. Einsatz).
 *
 * DISPLAY only, and only on the way to the Rapport: the record keeps both blocks, because both
 * were really recorded and the Anwesenheit sheet is where a correction is made. The threshold is
 * the station's (`report.attendanceMergeGapMin`) — how long a break has to be before this Wehr
 * calls it one is a Weisung, not a number an EL settles at 3am.
 *
 * An OPEN block absorbs everything after it: there is nothing after «still here».
 */
export const DEFAULT_ATTENDANCE_MERGE_GAP_MIN = 15

export function mergeCloseBlocks(intervals: PresenceInterval[], gapMin: number): PresenceInterval[] {
  if (gapMin <= 0 || intervals.length < 2) return intervals
  const gapMs = gapMin * 60_000
  const out: PresenceInterval[] = []
  for (const iv of intervals) {
    const prev = out[out.length - 1]
    if (!prev) { out.push({ ...iv }); continue }
    // an unfinished previous block cannot be measured against the next one's start, and an
    // unparseable stamp must not silently swallow a stretch — both stay separate
    const end = prev.to ? Date.parse(prev.to) : NaN
    const start = Date.parse(iv.from)
    if (Number.isFinite(end) && Number.isFinite(start) && start - end < gapMs) {
      // the LATER end wins, including «no end at all» — coming back and still being here
      // means the merged stretch is still running
      out[out.length - 1] = { from: prev.from, to: iv.to }
      continue
    }
    out.push({ ...iv })
  }
  return out
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : null
}

/**
 * Minutes actually served: the blocks summed, so the hours a person was AWAY between two of them
 * are not billed. Missing ends fall back to Alarmierung / Einsatzende, as they always did; a block
 * that still can't be resolved makes the whole figure null rather than a quietly short one.
 */
export function totalMinutes(intervals: PresenceInterval[], opts: { alarmedAt: string | null; endedAt: string | null }): number | null {
  // an entry with no block at all still falls back to Alarmierung → Einsatzende, as it always did
  const list: (PresenceInterval | null)[] = intervals.length ? intervals : [null]
  let sum = 0
  for (const iv of list) {
    const a = ms(iv?.from ?? opts.alarmedAt)
    const b = ms(iv?.to ?? opts.endedAt)
    if (a == null || b == null) return null
    // ⚠️ A block that ends before it starts is NOT zero minutes — it is a block nobody can
    // total, and saying «0:00» claims it was measured. The common way to get one is not a
    // mistyped block at all: an OPEN block borrows the incident's Einsatzende, so a single
    // implausible Einsatzende silently zeroed every person still on scene — four people,
    // «Einsatzstunden 0:00», nothing on the sheet saying why. Unresolved instead, which the
    // summary already counts and reports separately.
    if (b < a) return null
    sum += b - a
  }
  return Math.round(sum / 60_000)
}
