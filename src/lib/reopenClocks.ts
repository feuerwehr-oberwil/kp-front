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
 *    (AGENTS.md · what every device OBSERVES is recorded under a DERIVED id, once);
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
  let best: LifecycleBoundary | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const kind = row.lifecycle ?? legacyKind(row)
    if (!kind || !row.at) continue
    const ms = Date.parse(row.at)
    if (!Number.isFinite(ms) || ms < bestMs) continue
    best = { kind, id: row.id, at: row.at }
    bestMs = ms
  }
  return best
}

/** The derived id of one crew's restart row — one per reopen and crew, on every device. */
export const clockRestartRowId = (reopenRowId: string, truppId: string): string => `azro-${reopenRowId}-${truppId}`

/**
 * The Trupps with the contact clock of every crew still inside restarted at the reopen. Only a
 * clock that last ran BEFORE the reopen moves: a Kontakt given since stands. Returns the SAME
 * array when nothing moves (a machine writer must be idempotent — AGENTS.md).
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
    // …and says it was a RESTART, so the alarm this ends names the reopen, not a Funkkontakt (D5)
    return { ...t, lastContactTime: reopen.at, contactRestartedAt: reopen.at }
  })
  return changed ? next : trupps
}
