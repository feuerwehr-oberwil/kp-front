// Liste: an organizer's work list, read-only and in its own order. «Besucht» = a completed visit
// for the object WITH this list's reference; there is no separate tick (design PLAN §2.3).

import { useMemo } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { knownVisits, lastSeen, listProgress, visitsAtStop } from '../../objectVisits/catalogue'
import { answerStats } from '../../objectVisits/doc'
import { pendingUploads } from '../../objectVisits/outbox'
import { Head } from './common'
import { fmtDate, fmtDayShort, plural } from './ovFormat'
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
  const sub = [fillTemplate(C.listSub, { done: p.done, total: p.total }), list.scheduledOn ? fillTemplate(C.listOn, { date: fmtDate(list.scheduledOn) }) : list.closesAt ? fillTemplate(C.listUntil, { date: fmtDate(list.closesAt) }) : null]
    .filter(Boolean).join(' · ')
  const unresolved = list.unresolved?.length ?? 0
  const missingHere = list.objectIds.filter((id) => !byId.has(id)).length

  return (
    <>
      <Head title={list.title} sub={sub} onBack={back} />
      <div className={s.body}>
        <div className={s.col}>
          {list.archived && <p className={s.lead}>{C.listArchived}</p>}
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
              const atStop = visitsAtStop(known, id, list.ref)
              const findings = atStop.filter((x) => x.lifecycle === 'completed').reduce((n, x) => {
                const l = ov.locals.find((y) => y.doc.id === x.id)
                return n + (l ? answerStats(l.doc).defects : x.findings ?? 0)
              }, 0)
              // done is the green number; the chip is what still needs an eye — photos on the way,
              // Mängel, a draft — never the date again (owner, 15.10.2026: «zuletzt 13.10.» beside
              // «✓ 13.10.» was one fact twice)
              const chip = photosOut ? <span className="ip-badge ip-badge-todo">{C.statePhotos}</span>
                : findings > 0 ? <span className="ip-badge ip-badge-todo">{plural(findings, C.defectsOne, C.defectsMany)}</span>
                  : v && v.lifecycle !== 'completed' ? <span className="ip-badge ip-badge-arch">{C.stateDraft}</span>
                    : null
              const seen = catalogue ? lastSeen(catalogue, o) : null
              const real = v?.lifecycle === 'completed' ? v : null
              const subLine = [
                atStop.length > 1 ? fillTemplate(C.stopChecklists, { n: atStop.length }) : null,
                o.address,
                // a date only where it is not the round's own day (a list without a day: always)
                real?.visitedAt && real.visitedAt.slice(0, 10) !== list.scheduledOn ? fmtDayShort(real.visitedAt) : null,
                // the organizer's completion, where no visit of this list stands for it
                !real && prior ? [C.listDoneElsewhere, fmtDayShort(prior.at), prior.source].filter(Boolean).join(' ') : null,
                // an open stop: when it was last done anywhere — the one date worth planning by
                stop.done ? null : seen ? fillTemplate(C.lastVisit, { date: fmtDate(seen.at) }) : C.neverVisited,
              ].filter(Boolean).join(' · ')
              const open = () => {
                if (v) ov.go({ kind: 'visit', id: v.id })
                else if (ov.canCapture && !list.archived) ov.go({ kind: 'new', object: o.id, ref: list.ref })
              }
              const door = !!v || (ov.canCapture && !list.archived)
              const inner = (
                <>
                  <span className={stop.done ? `${s.num} ${s.numDone}` : s.num} aria-label={stop.done ? `${i + 1} · ${C.listDoneElsewhere}` : undefined}>
                    {stop.done ? <Icon id="check" /> : i + 1}
                  </span>
                  <span className={s.rowMain}>
                    <span className={s.rowTitle}>{o.name}</span>
                    <span className={s.rowSub}>{subLine}</span>
                  </span>
                  {chip}
                  {door && <Icon id="chevron" className={s.chev} />}
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
