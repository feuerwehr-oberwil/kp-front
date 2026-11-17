// The hooks behind the visit's «Pläne» (PlansCard): the object's sheets, and the reader's open/close.

import { useCallback, useEffect, useRef, useState } from 'react'
import { getObjectResilient } from '../../lib/incidents'
import { moduleCatalogue } from '../../lib/planOrder'
import { visitPlanRows, type VisitPlanRow } from '../../objectVisits/plans'

/** The object's plan rows, read through the offline cache. Empty while loading and for an object without plans. */
export function useVisitPlans(objectId: string | null | undefined): VisitPlanRow[] {
  // keyed on the object, so a page reused for another visit never shows the previous one's plans
  const [loaded, setLoaded] = useState<{ objectId: string; rows: VisitPlanRow[] } | null>(null)
  useEffect(() => {
    if (!objectId) return
    let alive = true
    // an object without plans, or one this device cannot reach and never saw, simply has no card
    getObjectResilient(objectId)
      .then((o) => { if (alive) setLoaded({ objectId, rows: visitPlanRows(moduleCatalogue(), o.plans ?? []) }) })
      .catch(() => {})
    return () => { alive = false }
  }, [objectId])
  return loaded && loaded.objectId === objectId ? loaded.rows : []
}

/** How long after the reader closes a tap on the visit's ‹ — the same spot as the reader's — is
 *  taken as the second half of a double tap, not as «leave the visit». */
const CLOSE_SETTLE_MS = 500

/** Which sheet the reader shows (null = closed). `settling()` is true just after it closed: the
 *  visit's ‹ ignores taps then. The back gesture closes it through its Overlay, like every layer
 *  (lib/overlays/layer · useBackLayer, 17.11.2026 – it had an entry of its own until then). */
export function usePlanReader(): {
  index: number | null
  open: (i: number) => void
  show: (i: number) => void
  close: () => void
  settling: () => boolean
} {
  const [index, setIndex] = useState<number | null>(null)
  const closedAt = useRef(0)
  const close = useCallback(() => {
    closedAt.current = Date.now()
    setIndex(null)
  }, [])
  const settling = useCallback(() => Date.now() - closedAt.current < CLOSE_SETTLE_MS, [])
  return { index, open: setIndex, show: setIndex, close, settling }
}
