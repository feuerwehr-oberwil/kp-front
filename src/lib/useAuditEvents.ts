import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuditEventStore } from './auditEventStore'
import { newId } from './ids'
import type { SyncStatus } from './api/workspaceSync'

/** Capture tactical events durably under the incident and actor who made them. The server
 *  deduplicates client_id, so a lost response or unacknowledged teardown can safely retry. */
export function useAuditEvents(incidentId: string, readOnly: boolean, ownerId: string | null = null) {
  const [, changed] = useState(0)
  const store = useMemo(() => ownerId ? new AuditEventStore(incidentId, ownerId, readOnly) : null, [incidentId, ownerId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!store) return
    const unsubscribe = store.subscribe(() => changed((n) => n + 1))
    store.start()
    const online = () => { void store.flush() }
    const hidden = () => { if (document.visibilityState === 'hidden') store.flushKeepalive() }
    const pagehide = () => store.flushKeepalive()
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', pagehide)
    return () => {
      unsubscribe()
      store.stop()
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [store])
  useEffect(() => { store?.setReadOnly(readOnly) }, [store, readOnly])

  const emit = useCallback((op_type: string, payload?: Record<string, unknown>) => {
    if (readOnly) return
    store?.append({ client_id: newId('audit'), op_type, payload, occurred_at: new Date().toISOString() })
  }, [store, readOnly])
  const flushEvents = useCallback(() => store?.flush() ?? Promise.resolve(), [store])
  const flushEventsBeacon = useCallback(() => store?.flushKeepalive(), [store])

  const retry = useCallback(() => store?.retry() ?? Promise.resolve(), [store])
  const getStatus = useCallback((): SyncStatus => store?.status ?? 'synced', [store])
  const getRecoveryData = useCallback(() => store?.getRecoveryData() ?? null, [store])

  return {
    emit, flushEvents, flushEventsBeacon, retry, getStatus, getRecoveryData,
    pendingCount: store?.pendingCount ?? 0, rejectedCount: store?.rejectedCount ?? 0,
    cacheDurable: store?.cacheDurable ?? true, status: store?.status ?? 'synced',
  }
}
