import { truppInField } from './atemschutz'
import type { TimelineEvent, Trupp } from '../types'

/**
 * The Atemschutz clocks across «Wieder öffnen» (staging round 3, F4 — the reopen half).
 *
 * While an Einsatz is closed its clocks are frozen and its alarm is off (useAbschluss). Reopened,
 * a crew still recorded as inside counted the whole closed interval as time without contact and
 * rang «Überfällig» the instant the Einsatz ran again — on every device at once, about a crew
 * nobody had been asked about for an hour. After a reopen the question has to be asked again
 * from the reopen on: the contact clock of every crew still inside RESTARTS at the reopen, with
 * one row per crew saying so.
 *
 * Everything keys off the server's own boundary rows (backend · append_system_row `lifecycle`),
 * so every device computes the same restart from the same fact:
 *  - the moment is the reopen row's `at` — never a device's own clock;
 *  - the Verlauf row id is derived (`azro-<reopen row>-<Trupp>`), so three tablets write ONE row
 *    (docs/sync-and-offline.md · what every device OBSERVES is recorded under a DERIVED id, once);
 *  - until the reopen row has arrived on this device, the alarm HOLDS (`reopenPending`) rather
 *    than ring against the old contact time for the second the Verlauf takes to catch up.
 *
 * The close's own «beim Abschluss noch drin» row is written by the Abschluss (not here): this
 * only restarts clocks, it does not end sorties, and it never writes an Austritt.
 */

export interface LifecycleBoundary {
  kind: 'closed' | 'reopened'
  /** the server row's id — the key every device derives the restart rows from */
  id: string
  /** ISO, server time */
  at: string
  /** for a reopen: when the Einsatz had been closed before it (the close row just before) */
  closedAt?: string
}

/** Rows written before boundaries carried `lifecycle` say it in words (append_system_row). */
const legacyKind = (row: TimelineEvent): LifecycleBoundary['kind'] | null => {
  if (!row.id?.startsWith('sys')) return null
  if (row.text === 'Einsatz abgeschlossen' || row.text?.startsWith('Einsatz automatisch archiviert')) return 'closed'
  if (row.text?.startsWith('Einsatz wiedereröffnet')) return 'reopened'
  return null
}

/** The newest close/reopen boundary in the Verlauf (any order in, newest by `at` out). */
export function latestLifecycle(rows: readonly TimelineEvent[]): LifecycleBoundary | null {
  const all = rows
    // The server reserves this namespace at both journal append doors. Ordinary notes
    // (including older persisted rows) and enrichment patches cannot control the alarm.
    .filter((row) => row.id?.startsWith('sys') && !row.patchOf)
    .map((row) => ({ row, kind: row.lifecycle ?? legacyKind(row), ms: row.at ? Date.parse(row.at) : Number.NaN }))
    .filter((b): b is { row: TimelineEvent; kind: LifecycleBoundary['kind']; ms: number } => !!b.kind && Number.isFinite(b.ms))
    .sort((a, b) => a.ms - b.ms)
  const last = all[all.length - 1]
  if (!last) return null
  const out: LifecycleBoundary = { kind: last.kind, id: last.row.id, at: last.row.at! }
  if (last.kind === 'reopened') {
    const close = [...all].reverse().find((b) => b.kind === 'closed' && b.ms <= last.ms)
    if (close) out.closedAt = close.row.at
  }
  return out
}

/** The derived id of one crew's restart row — one per reopen and crew, on every device. */
export const clockRestartRowId = (reopenRowId: string, truppId: string): string => `azro-${reopenRowId}-${truppId}`

/**
 * The Trupps with the contact clock of every crew still inside restarted at the reopen. Only a
 * clock that last ran BEFORE the reopen moves: a Kontakt given since stands. Returns the SAME
 * array when nothing moves (a machine writer must be idempotent — lib/useGpsFollow).
 */
export function clocksAfterReopen(trupps: Trupp[], reopen: LifecycleBoundary | null): Trupp[] {
  if (!reopen || reopen.kind !== 'reopened') return trupps
  const at = Date.parse(reopen.at)
  if (!Number.isFinite(at)) return trupps
  let changed = false
  const next = trupps.map((t) => {
    if (!truppInField(t) || t.removedAt) return t
    const last = Date.parse(t.lastContactTime)
    if (Number.isFinite(last) && last >= at) return t
    changed = true
    // …and says it was a RESTART, so the alarm this ends names the reopen, not a Funkkontakt (D5),
    // and since when it had been closed, so the pressure estimate skips that time (r4)
    return {
      ...t, lastContactTime: reopen.at, contactRestartedAt: reopen.at, contactBeforeRestart: t.lastContactTime,
      ...(reopen.closedAt ? { pausedFrom: reopen.closedAt } : {}),
    }
  })
  return changed ? next : trupps
}

/**
 * Every stretch the Einsatz stood CLOSED and was then reopened, oldest first: `[closedAt,
 * reopenedAt]` in ms. The contact clock does not run while closed and RESTARTS at the reopen
 * (`clocksAfterReopen`) without any Trupp reading — so a reader of the log alone (the Rapport's
 * Auswertung) has to know these moments, or the closed time reads as an overdue crew.
 */
export function closedPauses(rows: readonly TimelineEvent[]): { from: number; to: number }[] {
  const all = rows
    .filter((row) => row.id?.startsWith('sys') && !row.patchOf)
    .map((row) => ({ kind: row.lifecycle ?? legacyKind(row), ms: row.at ? Date.parse(row.at) : Number.NaN }))
    .filter((b) => !!b.kind && Number.isFinite(b.ms))
    .sort((a, b) => a.ms - b.ms)
  const out: { from: number; to: number }[] = []
  let closed: number | null = null
  for (const b of all) {
    if (b.kind === 'closed') { if (closed == null) closed = b.ms }
    else if (b.kind === 'reopened') {
      // a reopen without a close row before it (an older record) still restarts the clock there
      out.push({ from: closed ?? b.ms, to: b.ms })
      closed = null
    }
  }
  return out
}
