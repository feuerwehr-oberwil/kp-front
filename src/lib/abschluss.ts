// Abschluss-Assistent step model: which of the guided closing steps are satisfied by the
// incident data. Pure derivation — the assistant never stores its own progress; reopening
// it weeks later shows the true state (the 3am tenet: recognition, no memorized state).

import type { ReportMeta } from './workspace'

// 'verlauf' was dropped 2026-07-08: system rows make the journal non-empty on every real
// incident, so the check was always-green noise on the closing list.
export type AbschlussStep = 'zeiten' | 'anwesenheit' | 'mittel' | 'abschluss'
export const ABSCHLUSS_STEPS: AbschlussStep[] = ['zeiten', 'anwesenheit', 'mittel', 'abschluss']

export interface AbschlussFacts {
  reportMeta: ReportMeta
  attendanceCount: number
  mittelCount: number
}

export function stepDone(step: AbschlussStep, f: AbschlussFacts): boolean {
  switch (step) {
    case 'zeiten':
      return !!f.reportMeta.endedAt
    case 'anwesenheit':
      return f.attendanceCount > 0
    case 'mittel':
      // zero entries is a legitimate rapport — but only when someone SAID so
      return f.mittelCount > 0 || !!f.reportMeta.mittelConfirmedNone
    case 'abschluss':
      return !!f.reportMeta.summary?.trim()
  }
}

export function missingSteps(f: AbschlussFacts): AbschlussStep[] {
  return ABSCHLUSS_STEPS.filter((s) => !stepDone(s, f))
}

/**
 * Apply an 'HH:MM' wall-clock time onto an existing ISO timestamp's calendar day (local
 * time). Used by the Stunden editor: the person edits times, the date rides along from
 * the original stamp — with `nextDayIfBefore` handling a span that crosses midnight
 * (bis 01:30 after von 22:00 lands on the following day).
 */
export function applyTimeToIso(baseIso: string, hhmm: string, opts?: { nextDayIfBefore?: string }): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const d = new Date(baseIso)
  if (!Number.isFinite(d.getTime())) return null
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (opts?.nextDayIfBefore) {
    const floor = new Date(opts.nextDayIfBefore)
    if (Number.isFinite(floor.getTime()) && d.getTime() < floor.getTime()) d.setDate(d.getDate() + 1)
  }
  return d.toISOString()
}
