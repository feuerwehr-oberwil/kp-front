// Wiedervorlagen (reminders), derived from the append-only Verlauf stream.
//
// The journal never edits or removes a row (see the kp-front-journal note), so a reminder's
// lifecycle is a SEQUENCE of events sharing one `reminder.id`:
//   - `created`  → carries the text (event.text) and the initial `dueAt`
//   - `snoozed`  → a later row with a new `dueAt`
//   - `done`     → a later row that closes it
// The open set and each reminder's *effective* due time are derived here — never stored as a
// mutable field. This keeps reminders correct under offline merge + replay for free.

import type { Surface, TimelineEvent } from '../types'

export interface OpenReminder {
  /** stable reminder id (the `created` row's reminder.id) */
  id: string
  /** timeline row id of the `created` event — target for "In Verlauf öffnen" */
  rowId: string
  /** reminder text (from the `created` row) */
  text: string
  /** effective due time (ISO): the latest snooze, else the original */
  dueAt: string
  /** when it was created (ISO), for age/sorting; '' if an older row lacked `at` */
  createdAt: string
  /** surface the reminder was raised on, for the Verlauf chip / jump */
  surface?: Surface
}

/**
 * Reduce the timeline to the still-open reminders, each with its effective due time.
 * Order-independent: events are folded oldest→newest so the latest op/dueAt wins regardless
 * of how the (newest-first) timeline is stored or merged.
 *
 * `closedAt` (the Einsatzende): reminders due BEFORE the incident was closed are expired by
 * closure — reopening a weeks-old incident for a Nachtrag must not fire stale überfällig
 * alarms the moment it opens.
 */
export function deriveReminders(timeline: readonly TimelineEvent[], closedAt?: string | null): OpenReminder[] {
  const created = new Map<string, TimelineEvent>()
  const latest = new Map<string, { op: 'created' | 'snoozed' | 'done'; dueAt?: string }>()

  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    const r = e.reminder
    if (!r) continue
    if (r.op === 'created') {
      created.set(r.id, e)
      latest.set(r.id, { op: 'created', dueAt: r.dueAt })
    } else {
      // a snooze without an explicit dueAt keeps the previous due
      latest.set(r.id, { op: r.op, dueAt: r.dueAt ?? latest.get(r.id)?.dueAt })
    }
  }

  const closedMs = closedAt ? Date.parse(closedAt) : NaN
  const open: OpenReminder[] = []
  for (const [id, c] of created) {
    const st = latest.get(id)
    if (!st || st.op === 'done') continue
    const dueAt = st.dueAt ?? c.reminder?.dueAt
    if (!dueAt) continue // malformed (created without a due) — skip rather than fire instantly
    if (Number.isFinite(closedMs) && Date.parse(dueAt) < closedMs) continue // expired by closure
    open.push({ id, rowId: c.id, text: c.text, dueAt, createdAt: c.at ?? '', surface: c.surface })
  }
  // soonest-due first; the banner shows the most urgent at the top
  return open.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
}

/** A reminder is due once its effective due time has passed. */
export function isDue(r: OpenReminder, nowMs: number): boolean {
  return Date.parse(r.dueAt) <= nowMs
}
