import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { SyncStatus } from '../lib/api/workspaceSync'

/** One recovery point for journal entries that have not reached the server. */
export function JournalDeliveryNotice({ status, count, onRetry, onExport }: {
  status: SyncStatus
  count: number
  onRetry: () => Promise<void>
  onExport: () => void
}) {
  const [busy, setBusy] = useState(false)
  const C = appConfig.copy.journal.delivery
  if (status === 'synced' || status === 'pending' || count === 0) return null
  const unsafe = status === 'storage'
  const run = async () => {
    if (busy) return
    setBusy(true)
    try { await onRetry() } catch { /* the notice stays until the delivery state confirms success */ } finally { setBusy(false) }
  }
  return (
    <div className={`jr-delivery${unsafe ? ' jr-delivery-danger' : ''}`} role={unsafe || status === 'error' ? 'alert' : 'status'}>
      <strong>{unsafe ? C.storageTitle : fillTemplate(C.failedTitle, { n: count })}</strong>
      <p>{unsafe ? C.storageBody : status === 'offline' ? C.offlineBody : C.savedBody}</p>
      <div className="jr-delivery-actions">
        <button type="button" className="ip-btn primary" disabled={busy} onClick={() => void run()}>{busy ? C.retrying : C.retry}</button>
        <button type="button" className="ip-btn" onClick={onExport}>{C.export}</button>
      </div>
    </div>
  )
}
