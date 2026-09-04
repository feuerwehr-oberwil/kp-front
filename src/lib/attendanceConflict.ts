// Attendance-divergence surfacing: when a three-way sync merge saw BOTH sides (local
// editor and server/QR capture) change the SAME person's attendance entry to different
// values, the merge stays last-writer-wins — but the divergence is appended to the Verlauf
// as ONE system note per affected person («bitte prüfen»), following the append-only
// journal pattern. This module is the pure part: signature-based de-duplication (the same
// conflict must not re-append on every sync cycle) and the row construction.

import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from './format'
import type { RecordConflict } from './mergeWorkspace'
import type { AttendanceEntry, AttendanceSource, TimelineEvent } from '../types'

/**
 * Stable identity of one reported divergence: person + both divergent values. A repeat report
 * of the exact same divergence (merge retries, later sync cycles re-merging the same episode)
 * collapses onto one journal row.
 *
 * ⚠️ The two sides are SORTED, so the signature is the same on both devices (04.09.). «Mine»
 * and «theirs» are a point of view — the tablet that kept its value and the one that lost it
 * see the identical episode with the halves swapped — so a signature in call order gave the
 * two devices two different identities for one divergence, and the record got the same «bitte
 * prüfen» line twice (03.09., Probst Tristan, 08:15:02 and 08:15:10). What the row reports is
 * that two values existed, not which of them happened to win the merge.
 */
export function conflictSignature(c: RecordConflict): string {
  const sides = [JSON.stringify(c.mine), JSON.stringify(c.theirs)].sort()
  return `${c.key}|${sides[0]}|${sides[1]}`
}

/** FNV-1a over the signature, base36 — a short, id-safe, device-independent name for one
 *  divergence. Only ever used to build a row id: two devices reporting the same episode mint
 *  the same id, and the server keeps the first (backend · journal.append_rows). */
function signatureKey(sig: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
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
 * Turn freshly reported record divergences into Verlauf rows, one per affected record,
 * skipping (and recording into `seen`) every signature already reported. `seen` is the
 * caller's session-scoped set — passing the same set across sync cycles is what guarantees no
 * duplicate events, so the same set must be passed on every cycle.
 *
 * Two surfaces report divergences (Anwesenheit and Atemschutz — see useIncidentSync) and they
 * differ in exactly two things: the id prefix and the sentence. Everything that matters is the
 * same by doctrine, and has to stay that way: the merge already resolved the record
 * field-by-field with nothing dropped, and the row exists so a human double-checks something
 * two devices wrote at once.
 */
export function conflictRows(
  conflicts: RecordConflict[],
  seen: Set<string>,
  { idPrefix, text, payload, now = new Date() }: {
    /** short, per-surface id namespace ('ac' | 'tc'), before the timestamp */
    idPrefix: string
    text: (conflict: RecordConflict) => string
    /** the structured half of the row — only the Anwesenheit has one today (see
     *  `attendanceConflictRows`); the Atemschutz reports and is read, not settled. */
    payload?: (conflict: RecordConflict, sig: string) => TimelineEvent['conflict']
    now?: Date
  },
): TimelineEvent[] {
  const rows: TimelineEvent[] = []
  for (const c of conflicts) {
    const sig = conflictSignature(c)
    if (seen.has(sig)) continue
    seen.add(sig)
    rows.push({
      // ⚠️ derived from the DIVERGENCE, not from this device's clock. Two tablets merging the
      // same episode mint the same id and the server keeps one row (backend ·
      // journal.append_rows); `seen` alone could not promise that — it is session memory on one
      // device, and it is empty again after a reload.
      id: `${idPrefix}${signatureKey(sig)}`,
      t: hhmm(now),
      at: now.toISOString(),
      icon: 'warn',
      text: text(c),
      ...(payload ? { conflict: payload(c, sig) } : {}),
    })
  }
  return rows
}

/**
 * The two values, in the SIGNATURE's own sorted order.
 *
 * ⚠️ Sorted, not «mine then theirs» — for the same reason `conflictSignature` sorts. Which half
 * a device calls its own is a point of view, and index 0 has to mean the same value on every
 * tablet, or the `resolved` row one of them writes would name the other one's choice.
 */
function conflictSides(c: RecordConflict): { source?: AttendanceSource; entry: AttendanceEntry }[] {
  return [c.mine, c.theirs]
    .filter((v): v is AttendanceEntry => !!v && typeof v === 'object')
    .map((entry) => ({ source: entry.source, entry }))
    .sort((a, b) => JSON.stringify(a.entry).localeCompare(JSON.stringify(b.entry)))
}

/** `conflictRows` for the Anwesenheit: one row per affected person, carrying both values so it
 *  can be settled later — see `openConflicts`. */
export const attendanceConflictRows = (conflicts: RecordConflict[], seen: Set<string>, now?: Date) =>
  conflictRows(conflicts, seen, {
    idPrefix: 'ac',
    now,
    text: (c) => fillTemplate(appConfig.copy.journal.attendanceConflict, { name: nameOf(c), what: conflictWhat(c) }),
    payload: (c, sig) => ({ op: 'raised', sig, key: c.key, sides: conflictSides(c) }),
  })

/** One divergence still waiting for somebody to look at it. */
export interface OpenConflict {
  /** the `raised` row's id — the Verlauf can be scrolled to it */
  rowId: string
  sig: string
  /** the Person the divergence is about */
  key: string
  name: string
  /** what diverged, as the row says it */
  what: string
  sides: { source?: AttendanceSource; entry: AttendanceEntry }[]
}

/**
 * The divergences that are still open — every `raised` row without a later `resolved` row for
 * the same `sig`.
 *
 * ⚠️ DERIVED, never stored, exactly like the Pendenzen (lib/reminders). The Verlauf is
 * append-only: settling a divergence appends a row that names it, it does not go back and change
 * the row that raised it. A record that could be edited to say a check happened would be no
 * proof that one did — and proof is the entire point of the 1.6 finding.
 *
 * Rows raised before 04.09. carry no `conflict` payload at all and can never be settled; they
 * are not returned, because an item nobody can close would leave the Abschluss-Schritt open for
 * ever on every Einsatz that already happened.
 */
export function openConflicts(events: readonly TimelineEvent[]): OpenConflict[] {
  const resolved = new Set<string>()
  for (const e of events) if (e.conflict?.op === 'resolved') resolved.add(e.conflict.sig)
  const out: OpenConflict[] = []
  const seen = new Set<string>()
  // oldest first, so the list reads in the order the divergences happened
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const c = e.conflict
    if (c?.op !== 'raised' || !c.sides?.length || resolved.has(c.sig) || seen.has(c.sig)) continue
    seen.add(c.sig)
    out.push({
      rowId: e.id,
      sig: c.sig,
      key: c.key ?? '',
      name: c.sides[0]?.entry.displayNameSnapshot ?? c.key ?? '',
      // the sentence the row already carries, minus the «Anwesenheit {name}: » the template
      // wrote in front of it — the card names the person in its own heading
      what: strippedWhat(e.text),
      sides: c.sides,
    })
  }
  return out
}

/** «Anwesenheit Stich Markus: unterschiedliche Zeiten erfasst – bitte prüfen.» → the middle. Read
 *  off the LIVE template, so it works on rows written in any locale (same trick as
 *  report · startsWithTemplate). Falls back to the whole sentence, which is never wrong. */
function strippedWhat(text: string): string {
  const tpl = appConfig.copy.journal.attendanceConflict
  const head = tpl.split('{what}')[0].split('{name}')
  const tail = tpl.split('{what}')[1] ?? ''
  let s = text
  if (head[0] && s.startsWith(head[0])) s = s.slice(head[0].length)
  const mid = head[1] ?? ''
  const at = mid ? s.indexOf(mid) : -1
  if (at >= 0) s = s.slice(at + mid.length)
  if (tail && s.endsWith(tail)) s = s.slice(0, -tail.length)
  return s.trim() || text
}

/** The row that CLOSES a divergence: what was decided, by whom. Appended like everything else. */
export function conflictResolvedRow(
  open: OpenConflict,
  choice: 0 | 1 | 'both',
  by: string | undefined,
  now: Date = new Date(),
): TimelineEvent {
  const C = appConfig.copy.journal
  const taken = choice === 'both' ? C.attendanceConflictKeepBoth : sideLabel(open.sides[choice])
  return {
    // one resolution per divergence, whichever device taps it — the same idempotency the
    // `raised` row has, for the same reason
    id: `acr${signatureKey(open.sig)}`,
    t: hhmm(now),
    at: now.toISOString(),
    icon: 'people',
    kind: 'team',
    text: fillTemplate(C.attendanceConflictResolved, {
      name: open.name,
      taken,
      by: by?.trim() || C.attendanceConflictByUnknown,
    }),
    conflict: { op: 'resolved', sig: open.sig, key: open.key, choice },
  }
}

/**
 * What ONE side of a divergence is called.
 *
 * ⚠️ The source where it is known, the VALUE where it is not (04.09.). «Vom Kommandoposten» is
 * the sentence that helps — but an AttendanceEntry only started carrying `source` on 04.09., so
 * every entry written before that, the whole 03.09. Einsatz included, has nothing to name. There
 * the times themselves are the label, which is always available and is the actual decision being
 * made anyway.
 */
export function sideLabel(side: { source?: AttendanceSource; entry: AttendanceEntry } | undefined): string {
  const C = appConfig.copy.journal
  if (!side) return C.attendanceConflictOther
  if (side.source) return side.source === 'capture' ? C.attendanceConflictFromCapture : C.attendanceConflictFromKp
  return sideValue(side.entry)
}

/** The side's own times, as one readable span — the fallback label, and the sub-line under the
 *  named source so the reader sees WHAT they are choosing either way. */
export function sideValue(e: AttendanceEntry): string {
  const C = appConfig.copy.journal
  const note = (e.note ?? '').trim()
  const blocks = e.intervals?.length
    ? e.intervals.map((iv) => `${hhmm(new Date(iv.from))}–${iv.to ? hhmm(new Date(iv.to)) : C.attendanceConflictOpenEnd}`)
    : e.checkedInAt
      ? [`${hhmm(new Date(e.checkedInAt))}–${e.leftAt ? hhmm(new Date(e.leftAt)) : C.attendanceConflictOpenEnd}`]
      : []
  return [blocks.join(', '), note].filter(Boolean).join(' · ') || C.attendanceConflictOther
}
