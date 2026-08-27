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

/** Both sides of one reported divergence. The merge is last-writer-wins and MINE is the writer
 *  that won (mergeWorkspace · mergeRecord), so `mine` is what now stands in the record and
 *  `theirs` is what was dropped — which is exactly the pair somebody has to check. */
const sides = (c: RecordConflict) => ({
  kept: c.mine as AttendanceEntry | undefined,
  dropped: c.theirs as AttendanceEntry | undefined,
})

/** The times an entry asserts, as one comparable string. Blocks are the truth where they exist;
 *  the derived first/last pair carries entries written before blocks did (types.ts). */
const timesOf = (e?: AttendanceEntry): string =>
  JSON.stringify([e?.intervals ?? null, e?.checkedInAt ?? null, e?.leftAt ?? null])

/**
 * WHAT diverged, in the words the row prints.
 *
 * ⚠️ The point of the row. It used to say only «abweichende Angaben … bitte prüfen», which hands
 * the reader a name, an instruction and nothing to act on — while the everyday case is perfectly
 * nameable: the same person picked up a Funktion at the QR sheet and another one at the KP, so
 * two are on file and one of them is now gone. Say that.
 *
 * Every field that actually differs is named; the Funktion carries its two values because they
 * are short and they ARE the question. A divergence in none of the known fields still reports —
 * an entry that grows a field this function has not learned yet must not fall silent.
 */
export function conflictWhat(c: RecordConflict): string {
  const C = appConfig.copy.journal
  const { kept, dropped } = sides(c)
  const out: string[] = []

  // ⚠️ BOTH Funktionen, side by side, and neither of them called «verworfen». The reader's job
  // is to decide which one is right, and for that they need to see the pair — which of the two
  // happens to sit in the record is a consequence of the merge order (last writer wins), not
  // the question being asked. Naming only the discarded one made the row read like a report of
  // data loss instead of a person who was booked twice.
  const a = (kept?.note ?? '').trim()
  const b = (dropped?.note ?? '').trim()
  if (a !== b) {
    out.push(a && b
      ? fillTemplate(C.attendanceConflictTwoNotes, { a, b })
      : fillTemplate(C.attendanceConflictOneNote, { a: a || b }))
  }
  if (kept?.status !== dropped?.status) out.push(C.attendanceConflictStatus)
  // absent reads as 'scene' everywhere else (lib/attendanceOrt · ortOf) — so it does here, or
  // an entry written before `ort` existed would report a divergence against every new one
  if ((kept?.ort ?? 'scene') !== (dropped?.ort ?? 'scene')) out.push(C.attendanceConflictOrt)
  if (timesOf(kept) !== timesOf(dropped)) out.push(C.attendanceConflictTimes)

  return out.length ? out.join(' · ') : C.attendanceConflictOther
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
      text: fillTemplate(appConfig.copy.journal.attendanceConflict, { name: nameOf(c), what: conflictWhat(c) }),
    })
  }
  return rows
}
