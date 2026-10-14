// `/besuche/neu?object=…&ref=…` — start a visit, or resume the open one (docs/object-visits.md ·
// Device): this device's and this person's draft for (object, workRef) wins over a new id, and
// nothing is sent until the first save point, so a reload of the link never makes a second visit.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { LoadingStatus } from '../ShellLoader'
import { knownVisits, resolveObject, visitTemplates, visitsAtStop } from '../../objectVisits/catalogue'
import { newVisitDoc, objectSnapshot } from '../../objectVisits/doc'
import { createLocalVisit, findOpenDraft } from '../../objectVisits/store'
import { decideNewVisit } from '../../objectVisits/newVisit'
import { lastWith } from '../../objectVisits/devicePrefs'
import type { CatalogueObject, VisitTemplate } from '../../objectVisits/types'
import { Head } from './common'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

export function NewVisit({ objectKey, workRef }: { objectKey: string; workRef: string | null }) {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const [chosen, setChosen] = useState<{ t: VisitTemplate | null } | null>(null)
  const [failed, setFailed] = useState(false)
  const started = useRef(false)
  const catalogue = ov.cat && (ov.cat.state === 'ready' || ov.cat.state === 'stale') ? ov.cat.catalogue : null
  // back where the stop came from: its work list, else the overview
  const back = () => ov.go(workRef && catalogue?.lists.some((l) => l.ref === workRef) ? { kind: 'list', ref: workRef } : { kind: 'overview' }, { replace: true })
  const object: CatalogueObject | null = catalogue ? resolveObject(catalogue, objectKey) : null
  // a draft for a bare object id resolves even without a catalogue on this device
  const draft = ov.localsLoaded
    ? findOpenDraft(ov.locals, object?.id ?? objectKey, workRef, ov.userId)
    : null
  const templates = useMemo(() => (catalogue ? visitTemplates(catalogue) : []), [catalogue])
  // the checklists already completed at this stop («Weitere Checkliste» from a finished visit)
  const doneHere = useMemo(() => new Set(
    visitsAtStop(knownVisits(ov.locals, ov.summaries), object?.id ?? objectKey, workRef)
      .filter((v) => v.lifecycle === 'completed' && v.checklist !== undefined)
      .map((v) => v.checklist?.id ?? null),
  ), [ov.locals, ov.summaries, object?.id, objectKey, workRef])
  // one checklist (or none) needs no question; several ask «Welche Checkliste?» — and so does the
  // one, once it is completed at this stop: «Weitere Checkliste» must not silently repeat it
  const choice = useMemo<{ t: VisitTemplate | null } | null>(
    () => chosen ?? (templates.length <= 1 && !doneHere.has(templates[0]?.id ?? null) ? { t: templates[0] ?? null } : null),
    [chosen, templates, doneHere],
  )
  const step = decideNewVisit({
    localsLoaded: ov.localsLoaded, localsOk: ov.localsOk, catalogueLoaded: ov.cat !== null,
    hasCatalogue: !!catalogue, object, draft, canCapture: ov.canCapture, choice,
  })

  useEffect(() => {
    if (started.current) return
    if (step.kind === 'resume' || step.kind === 'openLast') {
      started.current = true
      ov.go({ kind: 'visit', id: step.id }, { replace: true })
      return
    }
    if (step.kind !== 'create' || !object) return
    started.current = true
    const doc = newVisitDoc({ object: objectSnapshot(object), workRef, checklist: step.template, people: lastWith() })
    void createLocalVisit(doc, ov.userId).then((r) => {
      if (r.rec) ov.go({ kind: 'visit', id: doc.id }, { replace: true })
      else { started.current = false; setFailed(true) }
    })
  }, [step, object, ov, workRef])

  const body = (() => {
    if (step.kind === 'wait') return <div className={s.loadingLine}><LoadingStatus>{C.visitLoading}</LoadingStatus></div>
    if (step.kind === 'storage') {
      return (
        <div className={`form-warn ${s.msg}`} role="alert">
          <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.startFailed}</span></div>
          <p className={s.msgBody}>{C.storageWait}</p>
        </div>
      )
    }
    if (failed) {
      return (
        <div className={`form-warn ${s.msg}`} role="alert">
          <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.startFailed}</span></div>
          <p className={s.msgBody}>{C.unsavedBody}</p>
        </div>
      )
    }
    if (step.kind === 'notPrepared') {
      return (
        <div className={`form-warn form-warn-amber ${s.msg}`} role="status">
          <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.notPreparedTitle}</span></div>
          <p className={s.msgBody}>{C.notPreparedBody}</p>
          <div className={s.msgActs}><button type="button" className="form-warn-act" onClick={ov.reloadCatalogue}>{C.retry}</button></div>
        </div>
      )
    }
    if (step.kind === 'unknown') return <p className={s.lead}>{fillTemplate(C.objectUnknown, { key: objectKey })}</p>
    if (step.kind === 'readOnly') return <p className={s.lead}>{C.viewerNote}</p>
    if (step.kind === 'choose') {
      return (
        <>
          <p className={s.lead}>{C.chooseChecklistLead}</p>
          <div className={s.card}>
            {templates.map((t) => (
              <button key={t.id} type="button" className={s.row} onClick={() => setChosen({ t })}>
                <Icon id="checklist" className={s.rowGlyph} />
                <span className={s.rowMain}>
                  <span className={s.rowTitle}>{t.title}</span>
                  {t.subtitle && <span className={s.rowSub}>{t.subtitle}</span>}
                </span>
                {doneHere.has(t.id) && <span className="ip-badge ip-badge-ok">{C.checklistDone}</span>}
                <Icon id="chevron" className={s.chev} />
              </button>
            ))}
            <button type="button" className={s.row} onClick={() => setChosen({ t: null })}>
              {/* the glyph's room, so the title lines up with the checklists above */}
              <span className={s.rowGlyph} aria-hidden />
              <span className={s.rowMain}><span className={s.rowTitle}>{C.noChecklist}</span></span>
              {doneHere.has(null) && <span className="ip-badge ip-badge-ok">{C.checklistDone}</span>}
              <Icon id="chevron" className={s.chev} />
            </button>
          </div>
        </>
      )
    }
    return <div className={s.loadingLine}><LoadingStatus>{C.visitLoading}</LoadingStatus></div>
  })()

  return (
    <>
      <Head title={object?.name ?? C.title} sub={object?.address ?? (choice ? null : C.chooseChecklist)} onBack={back} />
      <div className={s.body}><div className={s.col}>{body}</div></div>
    </>
  )
}
