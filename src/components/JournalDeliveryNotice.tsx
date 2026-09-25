import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { SyncStatus } from '../lib/api/workspaceSync'

/** One recovery point for journal entries that have not reached the server.
 *
 *  `refused` (24.09.2026) counts audit events the server refused for a role that can never write
 *  them (auditEventStore · refused). They are not «not uploaded yet» — no retry delivers them —
 *  so they never make the notice an alert and never offer «Erneut versuchen»; but they are still
 *  only on this device, so while nothing else is outstanding a calm note keeps «Einträge
 *  sichern» in reach. Never dropped, never shouted.
 *
 *  `closedRefused` (25.09.2026, N3) counts what the CLOSED Einsatz no longer took — Verlauf rows
 *  and Tafel saves this device still had on the way when another device closed it
 *  (journalStore · refused, workspaceSync · parkRefused). The same calm shape, its own words:
 *  the reason is the Abschluss, not the role, and those rows are missing from the Verlauf above. */
export function JournalDeliveryNotice({ status, count, refused = 0, closedRefused = 0, onRetry, onExport }: {
  status: SyncStatus
  count: number
  refused?: number
  closedRefused?: number
  onRetry: () => Promise<void>
  onExport: () => void
}) {
  const [busy, setBusy] = useState(false)
  const C = appConfig.copy.journal.delivery
  const outstanding = count > 0 && status !== 'synced' && status !== 'pending'
  // a parked event on an undurable cache is still «not safely kept» — that warning stays loud
  if (!outstanding && !(status === 'storage' && refused + closedRefused > 0)) {
    if (closedRefused > 0 && status !== 'pending') {
      return (
        <div className="jr-delivery" role="status">
          <strong>{closedRefused === 1 ? C.closedTitleOne : fillTemplate(C.closedTitle, { n: closedRefused })}</strong>
          <p>{C.closedBody}</p>
          <div className="jr-delivery-actions">
            <button type="button" className="ip-btn" onClick={onExport}>{C.export}</button>
          </div>
        </div>
      )
    }
    if (!refused || status === 'pending') return null
    return (
      <div className="jr-delivery" role="status">
        <strong>{refused === 1 ? C.refusedTitleOne : fillTemplate(C.refusedTitle, { n: refused })}</strong>
        <p>{C.refusedBody}</p>
        <div className="jr-delivery-actions">
          <button type="button" className="ip-btn" onClick={onExport}>{C.export}</button>
        </div>
      </div>
    )
  }
  const unsafe = status === 'storage'
  const run = async () => {
    if (busy) return
    setBusy(true)
    try { await onRetry() } catch { /* the notice stays until the delivery state confirms success */ } finally { setBusy(false) }
  }
  return (
    <div className={`jr-delivery${unsafe ? ' jr-delivery-danger' : ''}`} role={unsafe || status === 'error' ? 'alert' : 'status'}>
      <strong>{unsafe ? C.storageTitle : count === 1 ? C.failedTitleOne : fillTemplate(C.failedTitle, { n: count })}</strong>
      <p>{unsafe ? C.storageBody : status === 'offline' ? C.offlineBody : C.savedBody}</p>
      <div className="jr-delivery-actions">
        <button type="button" className="ip-btn primary" disabled={busy} onClick={() => void run()}>{busy ? C.retrying : C.retry}</button>
        <button type="button" className="ip-btn" onClick={onExport}>{C.export}</button>
      </div>
    </div>
  )
}
