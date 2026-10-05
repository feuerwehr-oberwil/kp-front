// «Pläne» on a visit: the object's Modul-PDFs one tap away, above the checklist (src/objectVisits/plans).
//
// A plan opens IN the app (owner, 05.10.2026: «make the modules more part of the app, or at least
// with a straightforward way to get back»): a full-screen reader over the visit — the app's own
// PdfScroller, a «‹» back to the visit, the object's other sheets one tap away. It takes a history
// entry, so the phone's back gesture closes the reader instead of leaving the visit.

import { lazy, Suspense } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { referenceUrl } from '../../lib/api/reference'
import type { VisitPlanRow } from '../../objectVisits/plans'
import { LoadingStatus } from '../ShellLoader'
import { Segmented } from '../Segmented'
import { Overlay } from '../../lib/overlays'
import { Head } from './common'
import s from './ObjectVisits.module.css'

// pdf.js only loads once somebody opens a sheet
const PdfScroller = lazy(() => import('../PdfScroller').then((m) => ({ default: m.PdfScroller })))

export function PlansCard({ rows, onOpen }: { rows: VisitPlanRow[]; onOpen: (index: number) => void }) {
  const C = appConfig.copy.objectVisits
  if (!rows.length) return null
  return (
    <>
      <h2 className={s.sec}>{C.plans}</h2>
      <div className={s.card}>
        {rows.map((r, i) => (
          <button key={r.id} type="button" className={s.row} onClick={() => onOpen(i)}>
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

export function PlanReader({ rows, index, objectName, onShow, onClose }: {
  rows: VisitPlanRow[]
  index: number
  objectName: string
  onShow: (index: number) => void
  onClose: () => void
}) {
  const C = appConfig.copy.objectVisits
  const r = rows[index] ?? rows[0]
  if (!r) return null
  return (
    // the shared dialog behaviour (focus in, trapped and restored, Escape) — and no swipe-to-close:
    // a vertical drag here scrolls the plan
    <Overlay open onClose={onClose} className={`${s.page} ${s.reader}`} ariaLabel={r.title} swipeToClose={false}>
      <Head title={r.sub ? `${r.title} · ${r.sub}` : r.title} sub={objectName} onBack={onClose} />
      {rows.length > 1 && (
        <div className={s.planTabs}>
          <Segmented tabs ariaLabel={C.plans} value={index}
            options={rows.map((x, i) => ({ value: i, label: x.title }))} onChange={onShow} />
        </div>
      )}
      <div className={s.planBody}>
        <Suspense fallback={<div className={s.loadingLine}><LoadingStatus>{C.planLoading}</LoadingStatus></div>}>
          <PdfScroller key={r.id} url={referenceUrl(r.id, r.version)} bare />
        </Suspense>
      </div>
    </Overlay>
  )
}
