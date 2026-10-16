// `/besuche/neu?object=…&ref=…` — start a visit, or resume the open one (docs/object-visits.md ·
// Device): this device's and this person's draft for (object, workRef) wins over a new id, and
// nothing is sent until the first save point, so a reload of the link never makes a second visit.
//
// `/besuche/neu?lat=…&lng=…&label=…[&address=…]` is the same for a PLACE with no catalogue object
// (16.10.2026, contract C1): the chooser offers only the checklists whose `targets` include
// `location` (+ «Ohne Checkliste»), the draft at the same place (~1 m) is resumed, and the visit
// carries `object: null` with the place as its target. `&from=karte` travels on to the visit, so
// «Zurück» returns to Karte & Objekte.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { placeFilingFolder } from '../../lib/deploymentConfig'
import { LoadingStatus } from '../ShellLoader'
import { knownVisits, resolveObject, visitTemplates, visitsAtStop } from '../../objectVisits/catalogue'
import { newVisitDoc, objectSnapshot } from '../../objectVisits/doc'
import { placeKey, placeTarget, templatesFor, type PlaceQuery } from '../../objectVisits/place'
import { KARTE_PATH, type OvFrom } from '../../objectVisits/route'
import { createLocalVisit, findOpenDraft } from '../../objectVisits/store'
import { decideNewVisit } from '../../objectVisits/newVisit'
import { lastWith } from '../../objectVisits/devicePrefs'
import type { CatalogueObject, VisitTemplate } from '../../objectVisits/types'
import { Head } from './common'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

export function NewVisit({ objectKey = '', workRef = null, place = null, from }: {
  objectKey?: string
  workRef?: string | null
  /** a visit at a place (no object) */
  place?: PlaceQuery | null
  from?: OvFrom
}) {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const [chosen, setChosen] = useState<{ t: VisitTemplate | null } | null>(null)
  const [failed, setFailed] = useState(false)
  const started = useRef(false)
  const catalogue = ov.cat && (ov.cat.state === 'ready' || ov.cat.state === 'stale') ? ov.cat.catalogue : null
  // back where the launch came from: the Karte, the stop's work list, else the overview
  const back = () => {
    if (from === 'karte') { ov.exit(KARTE_PATH); return }
    ov.go(workRef && catalogue?.lists.some((l) => l.ref === workRef) ? { kind: 'list', ref: workRef } : { kind: 'overview' }, { replace: true })
  }
  const object: CatalogueObject | null = catalogue && !place ? resolveObject(catalogue, objectKey) : null
  const target = place ? placeTarget(place, C.placeUnnamed) : null
  const isPlace = !!target
  // the stop: the object (a bare id resolves even without a catalogue), or the place
  const stopKey = place ? placeKey(place) : object?.id ?? objectKey
  const draft = ov.localsLoaded ? findOpenDraft(ov.locals, stopKey, workRef, ov.userId) : null
  const templates = useMemo(() => (catalogue ? templatesFor(visitTemplates(catalogue), isPlace ? 'location' : 'object') : []), [catalogue, isPlace])
  // the checklists already completed at this stop («Weitere Checkliste» from a finished visit)
  // (plain values, no memo: a handful of rows, and the React compiler memoizes what it can)
  const doneHere = new Set(
    visitsAtStop(knownVisits(ov.locals, ov.summaries), stopKey, workRef)
      .filter((v) => v.lifecycle === 'completed' && v.checklist !== undefined)
      .map((v) => v.checklist?.id ?? null),
  )
  // one checklist (or none) needs no question; several ask «Welche Checkliste?» — and so does the
  // one, once it is completed at this stop: «Weitere Checkliste» must not silently repeat it
  const choice: { t: VisitTemplate | null } | null =
    chosen ?? (templates.length <= 1 && !doneHere.has(templates[0]?.id ?? null) ? { t: templates[0] ?? null } : null)
  const step = decideNewVisit({
    localsLoaded: ov.localsLoaded, localsOk: ov.localsOk, catalogueLoaded: ov.cat !== null,
    hasCatalogue: !!catalogue, object, place: !!target, draft, canCapture: ov.canCapture, choice,
  })

  useEffect(() => {
    if (started.current) return
    if (step.kind === 'resume' || step.kind === 'openLast') {
      started.current = true
      ov.go({ kind: 'visit', id: step.id, ...(from ? { from } : {}) }, { replace: true })
      return
    }
    if (step.kind !== 'create' || (!object && !target)) return
    started.current = true
    const doc = target
      ? newVisitDoc({ place: target, workRef, checklist: step.template, people: lastWith() })
      : newVisitDoc({ object: objectSnapshot(object!), workRef, checklist: step.template, people: lastWith() })
    void createLocalVisit(doc, ov.userId).then((r) => {
      if (r.rec) ov.go({ kind: 'visit', id: doc.id, ...(from ? { from } : {}) }, { replace: true })
      else { started.current = false; setFailed(true) }
    })
  }, [step, object, target, ov, workRef, from])

  const filing = target ? placeFilingFolder() : null
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
          <p className={s.lead}>
            {target ? (filing ? fillTemplate(C.placeChooseLeadFolder, { folder: filing }) : C.placeChooseLead) : C.chooseChecklistLead}
          </p>
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

  const title = target ? fillTemplate(C.placeTitle, { label: target.label }) : object?.name ?? C.title
  const sub = target ? (choice ? null : C.chooseChecklist) : object?.address ?? (choice ? null : C.chooseChecklist)
  return (
    <>
      <Head title={title} sub={sub} onBack={back} />
      <div className={s.body}><div className={s.col}>{body}</div></div>
    </>
  )
}
