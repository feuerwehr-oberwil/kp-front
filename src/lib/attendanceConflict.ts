// Attendance-divergence surfacing: when a three-way sync merge saw BOTH sides (local
// editor and server/QR capture) change the SAME person's attendance entry to different
// values, the merge stays last-writer-wins — but the divergence is appended to the Verlauf
// as ONE system note per affected person («bitte prüfen»), following the append-only
// journal pattern. This module is the pure part: signature-based de-duplication (the same
// conflict must not re-append on every sync cycle) and the row construction.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { RecordConflict } from './mergeWorkspace'
import type { AttendanceEntry, TimelineEvent } from '../types'

/** Stable identity of one reported divergence: person + both divergent values. A repeat
 *  report of the exact same divergence (merge retries, later sync cycles re-merging the
 *  same episode) collapses onto one journal row. */
export function conflictSignature(c: RecordConflict): string {
  return `${c.key}|${JSON.stringify(c.mine)}|${JSON.stringify(c.theirs)}`
}

const nameOf = (c: RecordConflict): string => {
  const mine = c.mine as AttendanceEntry | undefined
  const theirs = c.theirs as AttendanceEntry | undefined
  return mine?.displayNameSnapshot ?? theirs?.displayNameSnapshot ?? c.key
}

/**
 * Turn freshly reported attendance conflicts into journal rows, one per affected person,
 * skipping (and recording into `seen`) every signature already reported. `seen` is the
 * caller's session-scoped set — passing the same set across sync cycles is what guarantees
 * no duplicate events.
 */
export function attendanceConflictRows(
  conflicts: RecordConflict[],
  seen: Set<string>,
  now: Date = new Date(),
): TimelineEvent[] {
  const rows: TimelineEvent[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  for (const c of conflicts) {
    const sig = conflictSignature(c)
    if (seen.has(sig)) continue
    seen.add(sig)
    rows.push({
      id: `ac${now.getTime()}-${rows.length}`, // prefixed timestamp, same convention as 'e'+Date.now()+'-'+i
      t: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      at: now.toISOString(),
      icon: 'warn',
      text: fillTemplate(appConfig.copy.journal.attendanceConflict, { name: nameOf(c) }),
    })
  }
  return rows
}
