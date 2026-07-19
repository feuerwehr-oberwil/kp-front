import { useCallback, useEffect, useRef } from 'react'
import { ingestEvents, ingestEventsBeacon, type ClientEvent } from './incidents'

/**
 * Audit capture (substrate A): buffer client tactical events (`emit`) and flush them to the server
 * debounced, re-queueing on a failed flush. `flushEventsBeacon` is the teardown-safe variant (a
 * keepalive beacon that survives the document unloading on tab-hide / pagehide). Extracted from
 * App's god-component so the audit-stream wiring lives as one small, testable unit.
 */
export function useAuditEvents(incidentId: string, readOnly: boolean) {
  const evBuf = useRef<ClientEvent[]>([])
  const evTimer = useRef<number | null>(null)
  const flushEventsRef = useRef<() => void>(() => {})
  const flushEvents = useCallback(() => {
    if (evTimer.current) { clearTimeout(evTimer.current); evTimer.current = null }
    const batch = evBuf.current
    if (!batch.length) return
    evBuf.current = []
    void ingestEvents(incidentId, batch).catch(() => {
      // Don't silently drop audit events on a failed flush — re-queue (oldest first) and retry.
      // Capped so a long offline spell can't grow the buffer without bound; the workspace blob
      // still carries the resulting state, this preserves the event stream.
      evBuf.current = [...batch, ...evBuf.current].slice(-1000)
      if (!evTimer.current) evTimer.current = window.setTimeout(() => flushEventsRef.current(), 8000)
    })
  }, [incidentId])
  useEffect(() => { flushEventsRef.current = flushEvents }, [flushEvents])

  const flushEventsBeacon = useCallback(() => {
    const batch = evBuf.current
    if (!batch.length) return
    evBuf.current = []
    ingestEventsBeacon(incidentId, batch)
  }, [incidentId])

  const emit = useCallback((op_type: string, payload?: Record<string, unknown>) => {
    if (readOnly) return
    evBuf.current.push({ op_type, payload, occurred_at: new Date().toISOString() })
    if (evTimer.current) clearTimeout(evTimer.current)
    evTimer.current = window.setTimeout(flushEvents, 4000)
  }, [readOnly, flushEvents])

  return { emit, flushEvents, flushEventsBeacon }
}
