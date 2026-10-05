// Übersicht: what is ready offline, my drafts, the work lists, search, «In der Nähe».

import { useEffect, useMemo, useState } from 'react'
import { localCalendarDay, visitSchedule, type ScheduleGroup } from '../../lib/visitSchedule'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { deploymentName } from '../../lib/deploymentConfig'
import { matchesAnyQuery, searchQuery } from '../../lib/search'
import { SearchField } from '../SearchField'
import { LoadingStatus } from '../ShellLoader'
import { knownVisits, lastSeen, listProgress, nearestObjects } from '../../objectVisits/catalogue'
import { deriveStatus } from '../../objectVisits/status'
import { isVisitDurable, type LocalVisit } from '../../objectVisits/store'
import { hasWork } from '../../objectVisits/outbox'
import type { Catalogue, CatalogueObject } from '../../objectVisits/types'
import { Head, Section } from './common'
import { fmtDate, fmtDistance, fmtWhen, plural, syncLabel } from './ovFormat'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

export function Overview() {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const [query, setQuery] = useState('')
  const [near, setNear] = useState<{ state: 'idle' | 'locating' | 'failed' } | { state: 'done'; at: { lat: number; lng: number } }>({ state: 'idle' })
  const catalogue: Catalogue | null = ov.cat && (ov.cat.state === 'ready' || ov.cat.state === 'stale') ? ov.cat.catalogue : null

  const mine = (v: LocalVisit) => !v.owner || !ov.userId || v.owner === ov.userId
  const drafts = ov.locals.filter((v) => v.doc.lifecycle === 'draft' && mine(v)).sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  // …and my drafts the server holds that this device does not (started on another device)
  const localIds = new Set(ov.locals.map((v) => v.doc.id))
  const serverDrafts = (ov.summaries ?? []).filter((v) =>
    v.lifecycle === 'draft' && !localIds.has(v.id) && !!ov.userId
    && typeof v.by === 'object' && v.by?.id === ov.userId)
  const unsent = ov.locals.filter((v) => v.doc.lifecycle === 'completed' && (hasWork(v) || v.dirty || !v.base))
  const known = useMemo(() => knownVisits(ov.locals, ov.summaries), [ov.locals, ov.summaries])

  const [today, setToday] = useState(() => localCalendarDay())
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localCalendarDay()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const groups = visitSchedule(catalogue?.lists ?? [], known, today)
  const listRows = (lists: NonNullable<typeof catalogue>['lists']) => (
    <div className={s.card}>{lists.map(l => {
      const p = listProgress(l, known)
      const sub = [plural(l.objectIds.length, C.listObjectsOne, C.listObjectsMany),
        l.scheduledOn ? fillTemplate(C.listOn, { date: fmtDate(l.scheduledOn) }) : l.closesAt ? fillTemplate(C.listUntil, { date: fmtDate(l.closesAt) }) : null,
        l.archived ? C.listArchived : null].filter(Boolean).join(' · ')
      return <button key={l.ref} type="button" className={s.row} onClick={() => ov.go({ kind: 'list', ref: l.ref })}>
        <span className={s.rowMain}><span className={s.rowTitle}>{l.title}</span><span className={s.rowSub}>{sub}</span>
          <span className={s.bar} aria-hidden><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} /></span>
        </span><span className={s.mono}>{p.done}/{p.total}</span><Icon id="chevron" className={s.chev} />
      </button>
    })}</div>
  )

  const q = searchQuery(query)
  const hits = catalogue && q ? catalogue.objects.filter((o) => matchesAnyQuery(q, o.name, o.address)).slice(0, 40) : []

  const locate = () => {
    if (!navigator.geolocation) { setNear({ state: 'failed' }); return }
    setNear({ state: 'locating' })
    navigator.geolocation.getCurrentPosition(
      (p) => setNear({ state: 'done', at: { lat: p.coords.latitude, lng: p.coords.longitude } }),
      () => setNear({ state: 'failed' }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  const suggested = catalogue && ov.suggestedObjectId
    ? catalogue.objects.find((o) => o.id === ov.suggestedObjectId) ?? null
    : null

  /** a capture role starts (or resumes) a visit; a reader opens the last one, if there is one */
  const openObject = (o: CatalogueObject, workRef: string | null = null) => {
    if (ov.canCapture) ov.go({ kind: 'new', object: o.id, ref: workRef })
    else if (o.lastVisit) ov.go({ kind: 'visit', id: o.lastVisit.id })
  }

  const objectRow = (o: CatalogueObject, extra?: string) => {
    const seen = catalogue ? lastSeen(catalogue, o) : null
    const sub = [o.address, seen ? fillTemplate(C.lastVisit, { date: fmtDate(seen.at) }) : C.neverVisited, extra].filter(Boolean).join(' · ')
    const door = ov.canCapture || !!o.lastVisit
    const inner = (
      <>
        <span className={s.rowMain}>
          <span className={s.rowTitle}>{o.name}</span>
          <span className={s.rowSub}>{sub}</span>
        </span>
        {door && <Icon id="chevron" className={s.chev} />}
      </>
    )
    // a door the role cannot go through is not drawn: a reader's never-visited object is a read-out
    return door
      ? <button key={o.id} type="button" className={s.row} onClick={() => openObject(o)}>{inner}</button>
      : <div key={o.id} className={s.rowStatic}>{inner}</div>
  }

  const draftRow = (v: LocalVisit) => {
    const st = deriveStatus({ rec: v, durable: isVisitDurable(v.doc.id, v.doc), flushing: false, sessionExpired: ov.sessionExpired })
    const label = syncLabel(st.sync)
    const tone = st.sync.kind === 'saved' ? 'ip-badge-ok' : 'ip-badge-todo'
    return (
      <button key={v.doc.id} type="button" className={s.row} onClick={() => ov.go({ kind: 'visit', id: v.doc.id })}>
        <span className={s.dot} aria-hidden />
        <span className={s.rowMain}>
          <span className={s.rowTitle}>{v.doc.object.name}</span>
          <span className={s.rowSub}>{[v.doc.object.address, fmtWhen(v.savedAt)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className={`ip-badge ${tone}`}>{label}</span>
      </button>
    )
  }

  return (
    <>
      <Head title={C.title} sub={deploymentName()} onBack={ov.exit} />
      <div className={s.body}>
        <div className={s.col}>
          {ov.cat === null && <div className={s.loadingLine}><LoadingStatus>{C.loading}</LoadingStatus></div>}


          {ov.cat?.state === 'missing' && (
            <div className={`form-warn form-warn-amber ${s.msg}`} role="status">
              <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.notPreparedTitle}</span></div>
              <p className={s.msgBody}>{C.notPreparedBody}</p>
              <div className={s.msgActs}><button type="button" className="form-warn-act" onClick={ov.reloadCatalogue}>{C.retry}</button></div>
            </div>
          )}
          {ov.cat?.state === 'refused' && (
            <div className={`form-warn ${s.msg}`} role="status">
              <div className={s.msgHead}><Icon id="lock" /><span className={s.msgTitle}>{C.refusedTitle}</span></div>
              <p className={s.msgBody}>{ov.cat.error.detail || C.refusedBody}</p>
            </div>
          )}
          {!ov.localsOk && (
            <div className={`form-warn form-warn-amber form-warn-compact`} role="status">
              <Icon id="warn" /><span className="form-warn-text">{C.storageUnreadable}</span>
            </div>
          )}

          {!ov.canCapture && catalogue && <p className={s.secNote}>{C.viewerNote}</p>}

          {/* opened from inside an Einsatz: its object first — the one whose plans are on the board */}
          {suggested && (
            <Section title={C.suggestedHead}>
              <div className={s.card}>{objectRow(suggested)}</div>
            </Section>
          )}

          {drafts.length + serverDrafts.length > 0 && (
            <Section title={C.myDrafts} count={drafts.length + serverDrafts.length}>
              <div className={s.card}>
                {drafts.map(draftRow)}
                {serverDrafts.map((v) => (
                  <button key={v.id} type="button" className={s.row} onClick={() => ov.go({ kind: 'visit', id: v.id })}>
                    <span className={s.dot} aria-hidden />
                    <span className={s.rowMain}>
                      <span className={s.rowTitle}>{v.objectName}</span>
                      <span className={s.rowSub}>{fmtWhen(v.updatedAt ?? v.visitedAt)}</span>
                    </span>
                    <span className="ip-badge ip-badge-arch">{fillTemplate(C.sync.remote, { n: v.revision })}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}
          {ov.cat?.state === 'missing' && drafts.length > 0 && <p className={s.secNote}>{C.notPreparedDrafts}</p>}
          {unsent.length > 0 && (
            <Section title={C.unsent} count={unsent.length}>
              <div className={s.card}>{unsent.map(draftRow)}</div>
            </Section>
          )}

          {/* past rounds are the organizer's record, not field work: only the last week's stay */}
          {(['today', 'overdue', 'upcoming', 'undated', 'recent'] as ScheduleGroup[]).map(group => groups[group].length > 0 && (
            <Section key={group} title={C.schedule[group as Exclude<ScheduleGroup, 'history'>]}>{listRows(groups[group])}</Section>
          ))}

          {catalogue && (
            <Section title={C.searchHead}>
              {catalogue.objects.length === 0 && drafts.length === 0 && <p className={s.secNote}>{C.intro}</p>}
              <SearchField value={query} onChange={setQuery} placeholder={C.searchPlaceholder} aria-label={C.searchPlaceholder} enterKeyHint="search" />
              {q && (hits.length
                ? <div className={s.card}>{hits.map((o) => objectRow(o))}</div>
                : <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q: query.trim() })}</p>)}
              {!q && (
                <div className={s.card}>
                  {near.state === 'done'
                    ? (() => {
                      const list = nearestObjects(catalogue, near.at)
                      return list.length
                        ? list.map(({ object, m }) => objectRow(object, fmtDistance(m)))
                        : <p className="no-hits">{C.nearbyNone}</p>
                    })()
                    : (
                      <button type="button" className={s.row} onClick={locate} disabled={near.state === 'locating'}>
                        <Icon id="locate" className={s.rowGlyph} />
                        <span className={s.rowMain}>
                          <span className={s.rowTitle}>{C.nearby}</span>
                          <span className={s.rowSub}>{near.state === 'locating' ? C.nearbyLocating : near.state === 'failed' ? C.nearbyFailed : C.nearbyUse}</span>
                        </span>
                        <Icon id="chevron" className={s.chev} />
                      </button>
                    )}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>
    </>
  )
}
