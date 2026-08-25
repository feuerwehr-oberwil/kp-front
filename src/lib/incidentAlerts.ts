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
 *
 * ⚠️ That override is BOUNDED, twice, and both bounds were missing until 23.08. — where the
 * other two rules in this file each carry a freshness window AND a per-device «I have seen
 * this» memory, this one had neither, so:
 *   - `now`: an alarm older than the window has stopped being the reason you picked up the
 *     tablet. Without this the comparison was against a fixed `started_at`, so an open alarm
 *     Einsatz kept winning next week, not just tonight.
 *   - `chosenAt`: an alarm that already existed when the operator DELIBERATELY opened something
 *     else does not get to drag them back on every reload. It is the same signal a dismissed
 *     banner carries, read from the cookie rather than a set (lib/prefs · incidentChosenAt).
 * A genuinely new alarm still wins, which is the case the rule exists for.
 */
export function pickBootIncident(
  list: IncidentMeta[],
  savedId: string | null | undefined,
  opts: { now: number; chosenAt?: number } = { now: Date.now() },
): IncidentMeta | undefined {
  const open = list.filter((i) => !i.is_archived)
  const saved = savedId ? open.find((i) => i.id === savedId) : undefined
  const newestAlarm = open
    .filter(isAlarmCreated)
    .reduce<IncidentMeta | undefined>((best, i) => (!best || ts(i.started_at) > ts(best.started_at) ? i : best), undefined)
  const overrides = newestAlarm != null
    && opts.now - ts(newestAlarm.started_at) < INCIDENT_ALERT_MAX_AGE_MS
    && (opts.chosenAt == null || ts(newestAlarm.started_at) > opts.chosenAt)
    && (!saved || ts(newestAlarm.started_at) > ts(saved.started_at))
  if (overrides) return newestAlarm
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

// --- intake review (what the take wizard used to be) ---------------------------------
// An alarm opens its own Einsatz now, so the dispatch's guesses — Stichwort, Kategorie,
// Priorität, Ort — reach the live map uncorrected. The review banner is where the EL fixes
// them: on the surface they are already looking at, with the Lage running behind it, rather
// than in a wizard that has to be got through before anyone can work.
//
// ⚠️ Unlike every other banner in this file, this one retires ACROSS DEVICES (25.08.): the
// dispatch's guesses are checked once by whoever gets there first, and until then every tablet
// and phone that opened the Einsatz put the same question up again — the crew's report was that
// the banner kept coming back on device after device, long after it had been answered at the
// desk. Tapping «Passt» (or saving a correction) stamps `intakeReviewedAt` on the incident's
// workspace blob (lib/workspace), and the other devices drop the banner on their next poll.
// The per-device set below stays as the local half: it retires the banner INSTANTLY on the
// tapping device (no waiting for a save + poll round trip) and keeps an offline device that
// reviewed on its own from re-nagging after a reload.
const REVIEWED_KEY = 'kp.incident.reviewed'

export function loadReviewedIncidents(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function saveReviewedIncident(id: string): void {
  try {
    const ids = [...loadReviewedIncidents().add(id)].slice(-DISMISS_CAP)
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(ids))
  } catch {
    /* private mode */
  }
}

/**
 * Should the correct-in-place review banner show for this incident? Only for an EDITOR (a
 * viewer can't correct anything), only for an incident an alarm opened by itself
 * (`auto_opened` — a human-created one was already reviewed while it was typed), only while
 * it is fresh, and only until it has been reviewed ANYWHERE: `reviewedAt` is the incident
 * workspace's shared stamp (someone else already confirmed it), `reviewed` this device's own
 * memory of having done so.
 */
export function needsIntakeReview(
  inc: IncidentMeta | null | undefined,
  opts: { isEditor: boolean; reviewed: ReadonlySet<string>; reviewedAt?: string | null; now: number },
): boolean {
  if (!inc || !opts.isEditor || !inc.auto_opened || inc.is_archived) return false
  if (opts.reviewedAt || opts.reviewed.has(inc.id)) return false
  return opts.now - ts(inc.started_at) < INCIDENT_ALERT_MAX_AGE_MS
}
