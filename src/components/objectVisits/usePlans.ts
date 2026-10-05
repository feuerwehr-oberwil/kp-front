// The hooks behind the visit's «Pläne» (PlansCard): the object's sheets, and the reader's open/close
// with the phone's back gesture wired to «close».

import { useCallback, useEffect, useRef, useState } from 'react'
import { getObjectResilient } from '../../lib/api/objects'
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

const READER_STATE = 'kp-front-ov-plan'

/** Which sheet the reader shows (null = closed), with the back gesture wired to «close». */
export function usePlanReader(): { index: number | null; open: (i: number) => void; show: (i: number) => void; close: () => void } {
  const [index, setIndex] = useState<number | null>(null)
  const pushed = useRef(false)
  useEffect(() => {
    const onPop = () => { if (pushed.current) { pushed.current = false; setIndex(null) } }
    window.addEventListener('popstate', onPop)
    // ⚠️ No history.back() on unmount: the surface is also left by a taken alarm (App ·
    // leaveObjectVisits replaces the address with «/»), and a back() then would walk into the
    // visit again. A spent entry only means one back gesture lands on the same visit.
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const open = useCallback((i: number) => {
    // the same address: the visit's route does not change, only a back gesture has somewhere to go
    if (!pushed.current) { window.history.pushState({ [READER_STATE]: true }, '', window.location.href); pushed.current = true }
    setIndex(i)
  }, [])
  const close = useCallback(() => {
    if (pushed.current) window.history.back() // popstate closes it
    else setIndex(null)
  }, [])
  return { index, open, show: setIndex, close }
}

