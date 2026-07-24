// Station-capture data layer: fetch wrappers for /api/capture/* (poster token) plus the
// PURE workspace mutations the capture view applies. The capture client is deliberately
// not WorkspaceSync — it holds no offline cache and no undo stack; each action re-applies
// onto the freshest server blob and retries once through a 409, so it composes with a
// live KP tablet exactly like a second (slow, narrow) editor.

import type { AttendanceEntry, MittelEntry, TimelineEvent } from '../types'
import type { ReportMeta } from './workspace'
import type { IncidentMeta, Workspace } from './incidents'
import { currentLineFor } from './mittel'

// --- pure mutations -------------------------------------------------------------------

export type CaptureAction =
  | { kind: 'cycleAttendance'; personId: string; name: string; vonIso?: string }
  | { kind: 'restoreAttendance'; personId: string; entry: AttendanceEntry }
  | { kind: 'setTimes'; personId: string; checkedInAt?: string; leftAt?: string }
  | { kind: 'setMeta'; patch: Partial<ReportMeta> }
  | { kind: 'setMittel'; materialId?: string; label: string; unit: string; sourceId?: string; sourceLabel?: string; menge: number; by: string }

/** frei → anwesend → gegangen → frei. «von» defaults to the ALARM time (`vonIso`, the
 *  field-classification's «Vorschlag ab Alarmzeit») — retro capture at the magazine would
 *  otherwise stamp everyone's arrival near the incident END. «bis» stays the tap moment. */
export function cycleAttendance(
  cur: AttendanceEntry | undefined, name: string, nowIso: string, vonIso?: string,
): AttendanceEntry | undefined {
  if (!cur) return { status: 'present', checkedInAt: vonIso ?? nowIso, displayNameSnapshot: name }
  if (cur.status === 'present') return { ...cur, status: 'left', leftAt: nowIso, displayNameSnapshot: name }
  return undefined // gegangen → frei (entry removed, same as the app's third tap)
}

/**
 * Apply one capture action onto a server workspace blob, touching ONLY the capture
 * domains (attendance / mittel / reportMeta.endedAt) — every other key is passed through
 * untouched, so a concurrent KP tablet's map work survives the PUT.
 */
export function applyAction(ws: Workspace | null, action: CaptureAction, nowIso: string): Workspace {
  const base: Record<string, unknown> = { ...(ws ?? {}) }
  if (action.kind === 'cycleAttendance') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    const next = cycleAttendance(attendance[action.personId], action.name, nowIso, action.vonIso)
    if (next) attendance[action.personId] = next
    else delete attendance[action.personId]
    base.attendance = attendance
    return base
  }
  if (action.kind === 'restoreAttendance') {
    // undo of the destructive third tap: put the removed entry (incl. its times) back verbatim
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    attendance[action.personId] = action.entry
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setTimes') {
    const attendance = { ...((base.attendance as Record<string, AttendanceEntry> | undefined) ?? {}) }
    const cur = attendance[action.personId]
    if (!cur) return base // times only refine an existing entry, never create one
    attendance[action.personId] = {
      ...cur,
      ...(action.checkedInAt !== undefined ? { checkedInAt: action.checkedInAt } : {}),
      ...(action.leftAt !== undefined ? { leftAt: action.leftAt } : {}),
    }
    base.attendance = attendance
    return base
  }
  if (action.kind === 'setMeta') {
    base.reportMeta = { ...((base.reportMeta as Record<string, unknown> | undefined) ?? {}), ...action.patch }
    return base
  }
  // setMittel: append-only running total, no-op when unchanged (mirrors App.saveMittel)
  const mittel = [...((base.mittel as MittelEntry[] | undefined) ?? [])]
  const menge = Math.max(0, Math.round(action.menge))
  const probe = { materialId: action.materialId, label: action.label, unit: action.unit, sourceId: action.sourceId, sourceLabel: action.sourceLabel }
  const cur = currentLineFor(mittel, probe)
  if ((cur?.menge ?? 0) === menge) return base
  mittel.push({ id: `m${Date.parse(nowIso)}-${mittel.length}`, ...probe, menge, status: cur?.status, at: nowIso, by: action.by })
  base.mittel = mittel
  return base
}

// --- fetch layer (poster token in a header; the URL path carries it only for entry) -----

/**
 * Which incident the capture view opens without asking. The list now carries the whole
 * unreported backlog (any age), so "exactly one listed" is no longer the same as "the one
 * we just came back from": auto-open the single FRESH incident (started within the default
 * capture window) even when stale backlog rows sit below it. A lone backlog incident still
 * opens directly — with one row the picker adds nothing. Ties/ambiguity → show the list.
 */
export const CAPTURE_FRESH_MS = 12 * 60 * 60 * 1000 // mirrors alarms.captureWindowHours default
export function autoOpenTarget(incidents: IncidentMeta[], nowMs: number): IncidentMeta | null {
  if (incidents.length === 1) return incidents[0]
  const fresh = incidents.filter((i) => nowMs - Date.parse(i.started_at) < CAPTURE_FRESH_MS)
  return fresh.length === 1 ? fresh[0] : null
}

export class CaptureError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** true when the failure is transport-shaped (no connection / aborted / stalled request)
 *  rather than a server verdict — those route into the offline banner, not the generic error */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof CaptureError) return false
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true
  return e instanceof TypeError // fetch's network-error shape
}

/** race a promise against a timeout — for the PDF/print paths whose fetch lives in shared
 *  libs; a stalled request must never leave the capture form permanently disabled */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DOMException('timeout', 'TimeoutError')), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e as Error) },
    )
  })
}

// clock-skew watch: /api/capture/* responses may carry X-Server-Time (ISO-8601 UTC) — the
// view registers a listener and warns when the device clock drifts. Absent header → silent.
let serverTimeListener: ((iso: string) => void) | null = null
export function onServerTime(fn: ((iso: string) => void) | null): void { serverTimeListener = fn }

const REQ_TIMEOUT_MS = 15_000

async function req<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  // hard abort after ~15s: a stalled request fails into the retry banner instead of
  // hanging the form on a phone with one bar of signal
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS)
  try {
    const r = await fetch(`/api/capture${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Capture-Token': token, ...(init?.headers ?? {}) },
    })
    const serverTime = r.headers.get('X-Server-Time')
    if (serverTime) serverTimeListener?.(serverTime)
    if (!r.ok) {
      let detail = ''
      try { detail = (await r.json())?.detail ?? '' } catch { /* non-JSON error body */ }
      throw new CaptureError(r.status, typeof detail === 'string' ? detail : '')
    }
    return (await r.json()) as T
  } finally { clearTimeout(timer) }
}

export interface CapturePerson { id: string; display_name: string; rank?: string | null }

export const captureApi = {
  incidents: (token: string) => req<IncidentMeta[]>(token, '/incidents'),
  roster: (token: string) => req<CapturePerson[]>(token, '/roster'),
  /** cross-visibility poll: has the KP tablet opened this incident (latched — once true,
   *  stays true, so the caller stops polling) */
  status: (token: string, id: string) => req<{ kp_active: boolean }>(token, `/incidents/${id}/status`),
  workspace: (token: string, id: string) =>
    req<{ workspace: Workspace | null; workspace_rev: number }>(token, `/incidents/${id}/workspace`),
  putWorkspace: (token: string, id: string, workspace: Workspace, base_rev: number) =>
    req<{ workspace: Workspace | null; workspace_rev: number }>(token, `/incidents/${id}/workspace`, {
      method: 'PUT', body: JSON.stringify({ workspace, base_rev }),
    }),
  verify: (token: string, id: string) =>
    req<{ intact: boolean; broken_at_seq: number | null; count: number; head?: string }>(token, `/incidents/${id}/verify`),
  journal: (token: string, id: string) =>
    req<{ entries: { seq: number; row: TimelineEvent }[]; latest_seq: number }>(token, `/incidents/${id}/journal`),
  appendJournal: (token: string, id: string, rows: TimelineEvent[]) =>
    req<{ latest_seq: number }>(token, `/incidents/${id}/journal`, {
      method: 'POST', body: JSON.stringify({ entries: rows }),
    }),
}

/**
 * Apply an action with fresh-read + one 409 retry: GET the blob, apply the pure mutation,
 * PUT; if a concurrent save won the race, re-read and re-apply once. Returns the saved blob.
 */
export async function saveAction(
  token: string, incidentId: string, action: CaptureAction,
): Promise<{ workspace: Workspace; rev: number }> {
  let attempt = 0
  for (;;) {
    const { workspace, workspace_rev } = await captureApi.workspace(token, incidentId)
    const next = applyAction(workspace, action, new Date().toISOString())
    try {
      const saved = await captureApi.putWorkspace(token, incidentId, next, workspace_rev)
      return { workspace: saved.workspace ?? next, rev: saved.workspace_rev }
    } catch (e) {
      if (e instanceof CaptureError && e.status === 409 && attempt < 2) { attempt += 1; continue }
      throw e
    }
  }
}
