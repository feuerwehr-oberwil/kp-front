// Übersicht: what is ready offline, my drafts, the work lists, search, «In der Nähe».

import { useEffect, useMemo, useState } from 'react'
import { localCalendarDay, visitSchedule, type ScheduleGroup } from '../../lib/visitSchedule'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, fmtWhen } from '../../lib/format'
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
import { fmtDate, fmtDistance, plural, recentPlaceVisits, summaryTitle, syncLabel, visitTitle } from './ovFormat'
import { useOv } from './ovContext'
import { ListCard, ListRow } from '../ListRow'
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
  // finished visits at a PLACE have no object to be found under: the recent ones get a list
  const placeVisits = recentPlaceVisits(ov.locals, ov.summaries)

  const [today, setToday] = useState(() => localCalendarDay())
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localCalendarDay()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const groups = visitSchedule(catalogue?.lists ?? [], known, today)
  const listRows = (lists: NonNullable<typeof catalogue>['lists']) => (
    <ListCard>{lists.map(l => {
      const p = listProgress(l, known)
      const sub = [plural(l.objectIds.length, C.listObjectsOne, C.listObjectsMany),
        l.scheduledOn ? fillTemplate(C.listOn, { date: fmtDate(l.scheduledOn) }) : l.closesAt ? fillTemplate(C.listUntil, { date: fmtDate(l.closesAt) }) : null,
        l.archived ? C.listArchived : null].filter(Boolean).join(' · ')
      return <ListRow key={l.ref} title={l.title} sub={sub} end={`${p.done}/${p.total}`} onClick={() => ov.go({ kind: 'list', ref: l.ref })}>
        <span className={s.bar} aria-hidden><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} /></span>
      </ListRow>
    })}</ListCard>
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
    // a door the role cannot go through is not drawn: a reader's never-visited object is a read-out
    return <ListRow key={o.id} title={o.name} sub={sub} onClick={door ? () => openObject(o) : undefined} />
  }

  // A draft's state at the row's end. «Gespeichert {Zeit}» is a small tick (owner, 28.10.2026: the
  // pill took 60% of a phone row, and the time already stands in the sub-line); every state that
  // asks for something – nicht gespeichert, Fehler, Konflikt … – keeps its word pill.
  const draftRow = (v: LocalVisit) => {
    const st = deriveStatus({ rec: v, durable: isVisitDurable(v.doc.id, v.doc), flushing: false, sessionExpired: ov.sessionExpired })
    const label = syncLabel(st.sync)
    const end = st.sync.kind === 'saved'
      ? <span className={s.savedTick} role="img" aria-label={label} title={label}><Icon id="check" /></span>
      : <span className="ip-badge ip-badge-todo">{label}</span>
    return (
      <ListRow key={v.doc.id} lead={<span className={s.dot} aria-hidden />} title={visitTitle(v.doc)}
        sub={[v.doc.object?.address, fmtWhen(v.savedAt, { todayShort: true })].filter(Boolean).join(' · ')}
        end={end} onClick={() => ov.go({ kind: 'visit', id: v.doc.id })} />
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
              <ListCard>{objectRow(suggested)}</ListCard>
            </Section>
          )}

          {drafts.length + serverDrafts.length > 0 && (
            <Section title={C.myDrafts} count={drafts.length + serverDrafts.length}>
              <ListCard>
                {drafts.map(draftRow)}
                {serverDrafts.map((v) => (
                  <ListRow key={v.id} lead={<span className={s.dot} aria-hidden />} title={summaryTitle(v)} sub={fmtWhen(v.updatedAt ?? v.visitedAt, { todayShort: true })}
                    end={<span className="ip-badge ip-badge-arch">{fillTemplate(C.sync.remote, { n: v.revision })}</span>}
                    onClick={() => ov.go({ kind: 'visit', id: v.id })} />
                ))}
              </ListCard>
            </Section>
          )}
          {ov.cat?.state === 'missing' && drafts.length > 0 && <p className={s.secNote}>{C.notPreparedDrafts}</p>}
          {unsent.length > 0 && (
            <Section title={C.unsent} count={unsent.length}>
              <ListCard>{unsent.map(draftRow)}</ListCard>
            </Section>
          )}

          {placeVisits.length > 0 && (
            <Section title={C.placeRecent}>
              <ListCard>
                {placeVisits.map((v) => (
                  <ListRow key={v.id} lead={<Icon id="pin" />} title={v.label}
                    sub={[fmtDate(v.visitedAt), v.checklist ?? C.noChecklist, v.people].filter(Boolean).join(' · ')}
                    onClick={() => ov.go({ kind: 'visit', id: v.id })} />
                ))}
              </ListCard>
            </Section>
          )}

          {/* past rounds are the organizer's record, not field work: only the last week's stay */}
          {(['today', 'overdue', 'upcoming', 'undated', 'recent'] as ScheduleGroup[]).map(group => groups[group].length > 0 && (
            <Section key={group} title={C.schedule[group as Exclude<ScheduleGroup, 'history'>]}>{listRows(groups[group])}</Section>
          ))}

          {catalogue && (
            <Section title={C.searchHead}>
              {/* the how-to stands until the member has a visit of their own – not only on an empty
                  catalogue, where nobody would ever have read it (sweep F.11, 23.10.2026) */}
              {drafts.length === 0 && <p className={s.secNote}>{C.intro}</p>}
              <SearchField value={query} onChange={setQuery} placeholder={C.searchPlaceholder} aria-label={C.searchPlaceholder} enterKeyHint="search" />
              {q && (hits.length
                ? <ListCard>{hits.map((o) => objectRow(o))}</ListCard>
                : <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q: query.trim() })}</p>)}
              {!q && (
                <ListCard>
                  {near.state === 'done'
                    ? (() => {
                      const list = nearestObjects(catalogue, near.at)
                      return list.length
                        ? list.map(({ object, m }) => objectRow(object, fmtDistance(m)))
                        : <p className="no-hits">{C.nearbyNone}</p>
                    })()
                    : (
                      <ListRow lead={<Icon id="locate" />} title={C.nearby} onClick={locate} disabled={near.state === 'locating'}
                        sub={near.state === 'locating' ? C.nearbyLocating : near.state === 'failed' ? C.nearbyFailed : C.nearbyUse} />
                    )}
                </ListCard>
              )}
            </Section>
          )}
        </div>
      </div>
    </>
  )
}
