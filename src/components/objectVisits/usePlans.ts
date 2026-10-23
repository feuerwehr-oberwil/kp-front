// The hooks behind the visit's «Pläne» (PlansCard): the object's sheets, and the reader's open/close
// with the phone's back gesture wired to «close».

import { useCallback, useEffect, useRef, useState } from 'react'
import { getObjectResilient } from '../../lib/incidents'
import { moduleCatalogue } from '../../lib/planOrder'
import { visitPlanRows, type VisitPlanRow } from '../../objectVisits/plans'
import { pushAppEntry } from '../../objectVisits/route'

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

/** How long after the reader closes a tap on the visit's ‹ — the same spot as the reader's — is
 *  taken as the second half of a double tap, not as «leave the visit». */
const CLOSE_SETTLE_MS = 500

/** Which sheet the reader shows (null = closed), with the back gesture wired to «close».
 *  `settling()` is true just after it closed: the visit's ‹ ignores taps then. */
export function usePlanReader(): {
  index: number | null
  open: (i: number) => void
  show: (i: number) => void
  close: () => void
  settling: () => boolean
} {
  const [index, setIndex] = useState<number | null>(null)
  const pushed = useRef(false)
  /** close()'s history.back() has not landed yet; a reopen meanwhile pushes once it has, or that
   *  late popstate would close the reopened reader and leave it without an entry */
  const backing = useRef(false)
  const reopened = useRef(false)
  const closedAt = useRef(0)
  const push = () => { pushAppEntry(window.location.href, { [READER_STATE]: true }); pushed.current = true }
  useEffect(() => {
    const onPop = () => {
      if (backing.current) {
        backing.current = false
        if (reopened.current) { reopened.current = false; push() }
      } else if (pushed.current) { pushed.current = false; closedAt.current = Date.now(); setIndex(null) }
    }
    window.addEventListener('popstate', onPop)
    // ⚠️ No history.back() on unmount: the surface is also left by a taken alarm, and App ·
    // leaveObjectVisits already walks back over every entry the surface pushed — this one
    // included (it is counted, route · pushAppEntry) — so a back() here would go one too far.
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const open = useCallback((i: number) => {
    // the same address: the visit's route does not change, only a back gesture has somewhere to go
    if (backing.current) reopened.current = true
    else if (!pushed.current) push()
    setIndex(i)
  }, [])
  const close = useCallback(() => {
    // closed at once, not on the popstate: a second tap before it arrived used to call back()
    // twice and leave the visit (reported on v0.12.0)
    reopened.current = false
    if (pushed.current) { pushed.current = false; backing.current = true; window.history.back() }
    closedAt.current = Date.now()
    setIndex(null)
  }, [])
  const settling = useCallback(() => Date.now() - closedAt.current < CLOSE_SETTLE_MS, [])
  return { index, open, show: setIndex, close, settling }
}
