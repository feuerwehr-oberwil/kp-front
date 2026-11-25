import type { TimelineEvent } from '../types'
import { latestLifecycle } from './reopenClocks'

/**
 * Is the Rapport's paper older than the Nachtrag it was reopened for?
 *
 * Owner pick UX journeys B3·18 (25.11.2026) overturns M5 · A (17.11.2026) for a REOPENED Einsatz
 * only. M5 · A: only an edit of a Rapport field makes the paper stale – a Verlauf row, the
 * Anwesenheit or the Mittel do not. That holds while the Einsatz runs. A Nachtrag after the close
 * exists only to change the record, though: a walker reopened, added a person to the Anwesenheit,
 * closed again over the PDF of 14:30, and the Akte kept a paper without that person.
 *
 * So after «Wieder öffnen» ANY change counts: a row a hand wrote after both the reopen and the
 * paper (the Anwesenheit and the Mittel write their own rows, a Verlauf entry is one). The close
 * then lists «Rapport von 14:30 – vor dem Nachtrag» (lib/abschlussOpen · `report`), and the
 * Rapport head offers the PDF again instead of the green close (ReportPreflight · closeReady).
 *
 * Derived, never written: `reportMadeAt` keeps its time (the close names it), every device reads
 * the same Verlauf, and a new PDF or print – a newer `reportMadeAt` – answers it.
 */
export function reportBeforeNachtrag(reportMadeAt: string | undefined, timeline: readonly TimelineEvent[]): boolean {
  const made = reportMadeAt ? Date.parse(reportMadeAt) : Number.NaN
  if (!Number.isFinite(made)) return false
  const reopen = latestLifecycle(timeline)
  if (reopen?.kind !== 'reopened') return false
  const since = Math.max(made, Date.parse(reopen.at))
  return timeline.some((e) => !isMachineRow(e) && !!e.at && Date.parse(e.at) > since)
}

/**
 * ⚠️ Rows no hand wrote, so they are no Nachtrag: the server's boundary rows (`sys…`), what the
 * devices' engines and the server's observers record under derived ids (docs/sync-and-offline.md ›
 * Observed facts get derived ids – the clock restart at the reopen `azro-`, the Atemschutz alarm
 * `azal-` / `azcl-`, GPS `vps-`, weather `wx:` / `wxd-`), and any observer row (`writtenAt`).
 * A new kind of observed row has to join this list, or a reopen alone makes the paper old.
 */
const MACHINE_ROW = /^(sys|azro-|azal-|azcl-|vps-|wx:|wxd-)/
const isMachineRow = (e: TimelineEvent): boolean => MACHINE_ROW.test(e.id) || !!e.writtenAt
