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
  /** Verlauf text for a done row on a timed Erinnerung, `{text}` = the item's text */
  doneLog: string
  /** …and on an undatierte Pendenz, which never called itself an Erinnerung */
  pendenzDoneLog: string
  /** Verlauf text for a snooze row, `{mins}` + `{text}` */
  snoozeLog: string
}

/** Same ids in the same order — the due set is derived from an ordered `open`, so order is stable. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Drives Wiedervorlagen off the append-only timeline: derives the open set and appends
 * done/snooze rows via `onEvent` — nothing here mutates the timeline. The CLOCK is not here:
 * which of the open ones are due, and the alert when one crosses, live in `RemindersHost`,
 * which the caller mounts with `<RemindersHost {...host} />`. The parent only learns the due
 * set when it CHANGES, so the 10 s tick never re-renders the caller.
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

  // the host's verdict — ids, so a re-derived `open` (a new row anywhere) never has to wait for
  // the next tick to show the right banner
  const [dueIds, setDueIds] = useState<readonly string[]>([])
  const onDue = useCallback((ids: readonly string[]) => setDueIds((prev) => (sameIds(prev, ids) ? prev : ids)), [])
  const due = useMemo(() => open.filter((r) => dueIds.includes(r.id)), [open, dueIds])

  // ⚠️ Two wordings, picked off the item itself: an undatierte Pendenz never called itself an
  // Erinnerung, so «Erinnerung erledigt: Absperrmaterial» would name a thing that never existed.
  const markDone = useCallback((r: OpenReminder) => {
    const tpl = r.dueAt ? copy.doneLog : copy.pendenzDoneLog
    onEvent({ icon: 'check', text: tpl.replace('{text}', r.text), reminder: { op: 'done', id: r.id } })
  }, [onEvent, copy.doneLog, copy.pendenzDoneLog])

  // ⚠️ 'bell', not 'clock' (23.08.). On the Verlauf the 26px disc IS the Bereich now, and 'clock'
  // was also the glyph the QR poster writes on an Anwesenheits-Zeitenzeile — one glyph, two
  // Bereiche, unreadable as a classification. The bell is the glyph the Erinnerung already wears
  // where the operator meets it (ReminderBanner), so nothing new has to be learned. Rows written
  // before the change keep 'clock' and still classify as Pendenz: they carry a `reminder`, which
  // `journalArea` answers long before it looks at the icon.
  const snooze = useCallback((r: OpenReminder, mins: number) => {
    const dueAt = new Date(Date.now() + mins * 60_000).toISOString()
    onEvent({
      icon: 'bell',
      text: copy.snoozeLog.replace('{mins}', String(mins)).replace('{text}', r.text),
      reminder: { op: 'snoozed', id: r.id, dueAt },
    })
  }, [onEvent, copy.snoozeLog])

  const host = useMemo(
    () => ({ open, enabled, dueTitle: copy.dueTitle, onDue }),
    [open, enabled, copy.dueTitle, onDue],
  )

  return { open, due, openCount: open.length, dueCount: due.length, markDone, snooze, host }
}

/**
 * Null-rendering host for the reminder clock — the same shape as `AtemschutzAlarmHost`, for the
 * same reason: the tick is component state, so whoever holds it re-renders on every beat. Held
 * by `useReminders` in IncidentWorkspace that was the whole 5800-line workspace — map overlays,
 * twin layers, whiteboard props — every 10 s from the first second of every Einsatz, reminders
 * or not. Here the tick re-renders only this empty component, and `onDue` reaches the parent
 * only when the SET of due ids changes (a crossing, a done, a snooze), never on a plain tick.
 *
 * Also owns the alert itself: a short tone (no loop — reminders aren't life-safety like the
 * SCBA clock) plus an OS notification when the app isn't in the foreground, once per crossing.
 */
export function RemindersHost({ open, enabled, dueTitle, onDue }: {
  open: readonly OpenReminder[]
  enabled: boolean
  dueTitle: string
  onDue: (ids: readonly string[]) => void
}): null {
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

  // alert once per reminder as it crosses into due
  const fired = useRef<Set<string>>(new Set())
  const toneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled) return
    const fresh = due.filter((r) => !fired.current.has(r.id))
    if (fresh.length === 0) return
    for (const r of fresh) {
      fired.current.add(r.id)
      if (typeof document !== 'undefined' && document.hidden) void notify(dueTitle, { body: r.text, tag: `reminder-${r.id}`, target: 'journal' })
    }
    startAlarm('warn')
    if (toneTimer.current) clearTimeout(toneTimer.current)
    toneTimer.current = setTimeout(() => stopAlarm(), 4000)
  }, [due, enabled, dueTitle])

  // a reminder that's resolved/snoozed before re-firing should be able to alert again later
  useEffect(() => {
    const openIds = new Set(open.map((r) => r.id))
    const dueIds = new Set(due.map((r) => r.id))
    for (const id of fired.current) if (!openIds.has(id) || !dueIds.has(id)) fired.current.delete(id)
  }, [open, due])

  useEffect(() => () => { if (toneTimer.current) clearTimeout(toneTimer.current); stopAlarm() }, [])

  // the parent hears about the SET, and only when it changes — `due` is a fresh array every
  // tick, so a reference check here would push a state update up on every beat
  const last = useRef<readonly string[]>([])
  useEffect(() => {
    const ids = due.map((r) => r.id)
    if (sameIds(last.current, ids)) return
    last.current = ids
    onDue(ids)
  }, [due, onDue])

  return null
}
