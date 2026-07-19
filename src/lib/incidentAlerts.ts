// Alarm-created incident awareness: which incident a cold start should land on, and which
// newly appeared incident deserves the «Neuer Einsatz» banner. Pure logic — the polling
// hook lives in useIncidentWatch.ts.

import type { IncidentMeta } from './incidents'

// Everything that is not human-created counts as alarm-created: 'divera' (taken OR
// auto-opened) and any generic-intake source slug.
const HUMAN_SOURCES = new Set(['manual', 'migrated'])
export const isAlarmCreated = (i: IncidentMeta): boolean => !HUMAN_SOURCES.has(i.source)

// Same freshness window as the Divera pool banner: don't announce stale alarms.
export const INCIDENT_ALERT_MAX_AGE_MS = 3 * 60 * 60 * 1000

const ts = (iso: string): number => {
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : 0
}

/**
 * Cold-start incident selection. The remembered incident normally wins, but a NEWER
 * alarm-created incident takes precedence — a killed app reopens onto the live alarm,
 * not onto yesterday's Einsatz. Archived incidents are never picked (an all-archived
 * deployment boots to the clean landing screen).
 */
export function pickBootIncident(list: IncidentMeta[], savedId: string | null | undefined): IncidentMeta | undefined {
  const open = list.filter((i) => !i.is_archived)
  const saved = savedId ? open.find((i) => i.id === savedId) : undefined
  const newestAlarm = open
    .filter(isAlarmCreated)
    .reduce<IncidentMeta | undefined>((best, i) => (!best || ts(i.started_at) > ts(best.started_at) ? i : best), undefined)
  if (newestAlarm && (!saved || ts(newestAlarm.started_at) > ts(saved.started_at))) return newestAlarm
  return saved ?? open[0]
}

/**
 * The incident (if any) the «Neuer Einsatz» banner should announce: alarm-created, fresh,
 * not the one already active, appeared AFTER this session's baseline poll, and not yet
 * dismissed on this device. Newest first when several qualify.
 */
export function freshAlarmCandidate(
  list: IncidentMeta[],
  opts: { activeId: string | null; baselineIds: ReadonlySet<string>; dismissed: ReadonlySet<string>; now: number },
): IncidentMeta | null {
  return (
    list
      .filter(
        (i) =>
          !i.is_archived &&
          isAlarmCreated(i) &&
          i.id !== opts.activeId &&
          !opts.baselineIds.has(i.id) &&
          !opts.dismissed.has(i.id) &&
          opts.now - ts(i.started_at) < INCIDENT_ALERT_MAX_AGE_MS,
      )
      .reduce<IncidentMeta | null>((best, i) => (!best || ts(i.started_at) > ts(best.started_at) ? i : best), null)
  )
}

/** Cheap change check so the 30 s poll doesn't re-render an unchanged list. capture_writes
 *  is compared explicitly: a QR journal append bumps only the counter (updated_at is pinned
 *  — bookkeeping, not a content change), and the QR-usage chip must still refresh. */
export function sameIncidentList(a: IncidentMeta[] | null, b: IncidentMeta[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((x, n) => x.id === b[n].id && x.updated_at === b[n].updated_at && x.capture_writes === b[n].capture_writes)
}

// Per-device dismissal (same pattern as the Divera pool banner's kp.divera.dismissed):
// a given incident only nags once on this device, across reloads. Capped so the tiny
// localStorage entry can't grow unbounded.
const DISMISS_KEY = 'kp.incident.dismissed'
const DISMISS_CAP = 50

export function loadDismissedIncidents(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function saveDismissedIncident(id: string): void {
  try {
    const ids = [...loadDismissedIncidents().add(id)].slice(-DISMISS_CAP)
    localStorage.setItem(DISMISS_KEY, JSON.stringify(ids))
  } catch {
    /* private mode */
  }
}
