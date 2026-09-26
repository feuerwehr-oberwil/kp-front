import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuditEventStore } from './auditEventStore'
import { onReachable } from './connectivity'
import { newId } from './ids'
import { serverNowIso } from './serverClock'
import { ALL_EVENTS, observedEventId, type EventScope } from './eventScope'
import type { SyncStatus } from './api/workspaceSync'

/** Capture tactical events durably under the incident and actor who made them. The server
 *  deduplicates client_id, so a lost response or unacknowledged teardown can safely retry.
 *  `scope` is what this session's role may append (lib/eventScope) — anything outside it is
 *  never queued, and a 403 for it is parked rather than held red (auditEventStore · refused). */
export function useAuditEvents(incidentId: string, readOnly: boolean, ownerId: string | null = null, scope: EventScope = ALL_EVENTS) {
  const [, changed] = useState(0)
  const store = useMemo(() => ownerId ? new AuditEventStore(incidentId, ownerId, readOnly, scope) : null, [incidentId, ownerId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!store) return
    const unsubscribe = store.subscribe(() => changed((n) => n + 1))
    store.start()
    const online = () => { void store.flush() }
    const hidden = () => { if (document.visibilityState === 'hidden') store.flushKeepalive() }
    const pagehide = () => store.flushKeepalive()
    window.addEventListener('online', online)
    // the server answered again without the browser saying so (lib/connectivity)
    const offReachable = onReachable(online)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', pagehide)
    return () => {
      unsubscribe()
      store.stop()
      window.removeEventListener('online', online)
      offReachable()
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [store])
  useEffect(() => { store?.setReadOnly(readOnly) }, [store, readOnly])
  useEffect(() => { store?.setScope(scope) }, [store, scope])

  /** `opts.observed` names an event EVERY device sees rather than one hand performs (the
   *  Atemschutz alarm, 24.09.2026): its `client_id` is derived from that key and this actor
   *  (`observedEventId`), so the same account on three devices lands ONE event — the server
   *  keeps the first and answers the others with it (backend · audit.append_event). */
  const emit = useCallback((op_type: string, payload?: Record<string, unknown>, opts?: { observed?: string }) => {
    if (readOnly) return
    const client_id = opts?.observed && ownerId ? observedEventId(opts.observed, ownerId) : newId('audit')
    // ⚠️ On the server-aligned clock (lib/serverClock), like every Verlauf `at`: a closed
    // Einsatz judges an event by WHEN it happened (backend · happened_after_close), and a device
    // clock minutes off would put a Kontakt from before the close after it, or the reverse.
    store?.append({ client_id, op_type, payload, occurred_at: serverNowIso() })
  }, [store, readOnly, ownerId])
  const flushEvents = useCallback(() => store?.flush() ?? Promise.resolve(), [store])
  const flushEventsBeacon = useCallback(() => store?.flushKeepalive(), [store])

  const retry = useCallback(() => store?.retry() ?? Promise.resolve(), [store])
  const requeueClosed = useCallback(() => store?.requeueClosed() ?? Promise.resolve(), [store])
  const getStatus = useCallback((): SyncStatus => store?.status ?? 'synced', [store])
  const getRecoveryData = useCallback(() => store?.getRecoveryData() ?? null, [store])

  return {
    emit, flushEvents, flushEventsBeacon, retry, requeueClosed, getStatus, getRecoveryData,
    pendingCount: store?.pendingCount ?? 0, rejectedCount: store?.rejectedCount ?? 0, refusedCount: store?.refusedCount ?? 0,
    closedCount: store?.closedCount ?? 0,
    cacheDurable: store?.cacheDurable ?? true, status: store?.status ?? 'synced',
  }
}
