import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineEvent } from '../types'
import { deriveReminders, isDue, type OpenReminder } from './reminders'
import { notify, startAlarm, stopAlarm } from './alarm'

/** payload App turns into an appended timeline row (keeps all timeline writes in one place) */
export interface ReminderEvent {
  icon: string
  text: string
  reminder: NonNullable<TimelineEvent['reminder']>
}

interface Copy {
  /** OS-notification title when a reminder comes due */
  dueTitle: string
  /** Verlauf text for a done row, `{text}` = reminder text */
  doneLog: string
  /** Verlauf text for a snooze row, `{mins}` + `{text}` */
  snoozeLog: string
}

/**
 * Drives Wiedervorlagen off the append-only timeline: derives the open set, watches for ones
 * coming due, and raises the shared alert (brief tone + an OS notification when backgrounded).
 * Resolving/snoozing appends new rows via `onEvent` — nothing here mutates the timeline.
 *
 * `enabled` is false during replay so historical reminders don't re-alarm while scrubbing.
 */
export function useReminders(
  timeline: readonly TimelineEvent[],
  onEvent: (ev: ReminderEvent) => void,
  copy: Copy,
  enabled = true,
  /** the Einsatzende — reminders due before it are expired by closure (no stale alarms on reopen) */
  closedAt?: string | null,
) {
  const open = useMemo(() => deriveReminders(timeline, closedAt), [timeline, closedAt])

  // coarse tick (10s) — promptly enough for a minute-granularity reminder without busy-looping.
  // ALSO recompute the instant the app resumes (visibility/focus): a device backgrounded or locked
  // throttles/pauses timers, so a reminder that came due while away would otherwise surface up to
  // 10s late in-app — recompute on resume so an overdue reminder is shown immediately at 3am.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const id = setInterval(tick, 10_000)
    const onResume = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [])

  const due = useMemo(() => (enabled ? open.filter((r) => isDue(r, now)) : []), [open, now, enabled])

  // alert once per reminder as it crosses into due: a short tone (don't loop — reminders aren't
  // life-safety like the SCBA clock) plus an OS notification when the app isn't in the foreground.
  const fired = useRef<Set<string>>(new Set())
  const toneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled) return
    const fresh = due.filter((r) => !fired.current.has(r.id))
    if (fresh.length === 0) return
    for (const r of fresh) {
      fired.current.add(r.id)
      if (typeof document !== 'undefined' && document.hidden) void notify(copy.dueTitle, { body: r.text, tag: r.id, target: 'journal' })
    }
    startAlarm('warn')
    if (toneTimer.current) clearTimeout(toneTimer.current)
    toneTimer.current = setTimeout(() => stopAlarm(), 4000)
  }, [due, enabled, copy.dueTitle])

  // a reminder that's resolved/snoozed before re-firing should be able to alert again later
  useEffect(() => {
    const openIds = new Set(open.map((r) => r.id))
    const dueIds = new Set(due.map((r) => r.id))
    for (const id of fired.current) if (!openIds.has(id) || !dueIds.has(id)) fired.current.delete(id)
  }, [open, due])

  useEffect(() => () => { if (toneTimer.current) clearTimeout(toneTimer.current); stopAlarm() }, [])

  const markDone = useCallback((r: OpenReminder) => {
    onEvent({ icon: 'check', text: copy.doneLog.replace('{text}', r.text), reminder: { op: 'done', id: r.id } })
  }, [onEvent, copy.doneLog])

  const snooze = useCallback((r: OpenReminder, mins: number) => {
    const dueAt = new Date(Date.now() + mins * 60_000).toISOString()
    onEvent({
      icon: 'clock',
      text: copy.snoozeLog.replace('{mins}', String(mins)).replace('{text}', r.text),
      reminder: { op: 'snoozed', id: r.id, dueAt },
    })
  }, [onEvent, copy.snoozeLog])

  return { open, due, openCount: open.length, dueCount: due.length, markDone, snooze }
}
