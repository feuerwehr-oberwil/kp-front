// «Pläne» on a visit: the object's Modul-PDFs one tap away, above the checklist (src/objectVisits/plans).

import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { getObjectResilient } from '../../lib/api/objects'
import { referenceUrl } from '../../lib/api/reference'
import { moduleCatalogue } from '../../lib/planOrder'
import { visitPlanRows, type VisitPlanRow } from '../../objectVisits/plans'
import s from './ObjectVisits.module.css'

export function PlansCard({ objectId }: { objectId: string | null | undefined }) {
  const C = appConfig.copy.objectVisits
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
  const rows = loaded && loaded.objectId === objectId ? loaded.rows : []
  if (!rows.length) return null
  return (
    <>
      <h2 className={s.sec}>{C.plans}</h2>
      <div className={s.card}>
        {rows.map((r) => (
          <button key={r.id} type="button" className={s.row}
            onClick={() => window.open(referenceUrl(r.id, r.version), '_blank', 'noopener')}>
            <Icon id="doc" className={s.rowGlyph} />
            <span className={s.rowMain}>
              <span className={s.rowTitle}>{r.title}</span>
              {r.sub && <span className={s.rowSub}>{r.sub}</span>}
            </span>
            <Icon id="chevron" className={s.chev} />
          </button>
        ))}
      </div>
    </>
  )
}
