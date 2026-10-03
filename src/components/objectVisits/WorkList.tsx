// Liste: an organizer's work list, read-only and in its own order. «Besucht» = a completed visit
// for the object WITH this list's reference; there is no separate tick (design PLAN §2.3).

import { useMemo } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { knownVisits, lastSeen, listProgress } from '../../objectVisits/catalogue'
import { pendingUploads } from '../../objectVisits/outbox'
import { Head } from './common'
import { fmtDate, fmtDayShort } from './ovFormat'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

export function WorkList({ listRef }: { listRef: string }) {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const catalogue = ov.cat && (ov.cat.state === 'ready' || ov.cat.state === 'stale') ? ov.cat.catalogue : null
  const list = catalogue?.lists.find((l) => l.ref === listRef) ?? null
  const known = useMemo(() => knownVisits(ov.locals, ov.summaries), [ov.locals, ov.summaries])
  const back = () => ov.go({ kind: 'overview' })

  if (!list || !catalogue) {
    return (
      <>
        <Head title={C.title} onBack={back} />
        <div className={s.body}><div className={s.col}><p className={s.lead}>{C.listUnknown}</p></div></div>
      </>
    )
  }

  const p = listProgress(list, known)
  const byId = new Map(catalogue.objects.map((o) => [o.id, o]))
  const sub = [fillTemplate(C.listSub, { done: p.done, total: p.total }), list.closesAt ? fillTemplate(C.listUntil, { date: fmtDate(list.closesAt) }) : null]
    .filter(Boolean).join(' · ')
  const unresolved = list.unresolved?.length ?? 0
  const missingHere = list.objectIds.filter((id) => !byId.has(id)).length

  return (
    <>
      <Head title={list.title} sub={sub} onBack={back} />
      <div className={s.body}>
        <div className={s.col}>
          {list.note && <p className={s.lead}>{list.note}</p>}
          {unresolved + missingHere > 0 && (
            <div className="form-warn form-warn-amber form-warn-compact" role="status">
              <Icon id="warn" /><span className="form-warn-text">{fillTemplate(C.listUnresolved, { n: unresolved + missingHere })}</span>
            </div>
          )}
          <div className={s.card}>
            {list.objectIds.map((id, i) => {
              const o = byId.get(id)
              if (!o) return null
              const stop = p.stops.get(id) ?? { done: false }
              const v = stop.visit
              const local = v ? ov.locals.find((l) => l.doc.id === v.id) : undefined
              const photosOut = local ? pendingUploads(local).length > 0 || local.sent?.ready === false : false
              const prior = stop.prior
              const priorText = prior ? [fmtDayShort(prior.at), prior.source].filter(Boolean).join(' · ') : ''
              // a real completed visit wins; else a draft says «Entwurf» (the organizer's earlier
              // completion moves to the line below); else the organizer's completion is the chip
              const chip = v?.lifecycle === 'completed'
                ? (photosOut
                  ? <span className="ip-badge ip-badge-todo">{C.statePhotos}</span>
                  : <span className="ip-badge ip-badge-ok">{fillTemplate(C.stateDone, { date: fmtDayShort(v.visitedAt) })}</span>)
                : v ? <span className="ip-badge ip-badge-todo">{C.stateDraft}</span>
                  : prior ? <span className="ip-badge ip-badge-ok">{fillTemplate(C.stateDone, { date: priorText })}</span>
                    : null
              const seen = catalogue ? lastSeen(catalogue, o) : null
              const subLine = [
                o.address,
                v && prior ? [C.listDoneElsewhere, fmtDate(prior.at), prior.source, prior.by].filter(Boolean).join(' ')
                  : seen ? fillTemplate(C.lastVisit, { date: fmtDate(seen.at) }) : C.neverVisited,
              ].filter(Boolean).join(' · ')
              const open = () => {
                if (v) ov.go({ kind: 'visit', id: v.id })
                else if (ov.canCapture) ov.go({ kind: 'new', object: o.id, ref: list.ref })
              }
              const door = !!v || ov.canCapture
              const inner = (
                <>
                  <span className={s.num}>{i + 1}</span>
                  <span className={s.rowMain}>
                    <span className={s.rowTitle}>{o.name}</span>
                    <span className={s.rowSub}>{subLine}</span>
                  </span>
                  {chip ?? (door && <Icon id="chevron" className={s.chev} />)}
                </>
              )
              return door
                ? <button key={id} type="button" className={s.row} onClick={open}>{inner}</button>
                : <div key={id} className={s.rowStatic}>{inner}</div>
            })}
          </div>
        </div>
      </div>
    </>
  )
}
