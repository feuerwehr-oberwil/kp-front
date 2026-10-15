// `/besuche/<id>/antworten` — a finished visit's answers on a screen of their own: the checklist,
// one line per question, then Bemerkungen, Fotos and Vorschläge. The visit page shows the visit as
// its card (VisitSections · SummaryCard); its head opens this. Kept off the visit page because the
// full output usually leaves through the filing, not this screen (owner, 15.10.2026).

import { useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { LoadingStatus } from '../ShellLoader'
import { Icon } from '../../lib/icons'
import { getVisit } from '../../objectVisits/api'
import { checklistItems, stripServer } from '../../objectVisits/doc'
import { pendingUploads } from '../../objectVisits/outbox'
import type { VisitDoc } from '../../objectVisits/types'
import { Head } from './common'
import { fmtDate, fmtWhen } from './ovFormat'
import { PhotoSheet } from './Sheets'
import { ChecklistSection, NotesSection, PhotosSection, ProposalsSection } from './VisitSections'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

const noop = () => {}

export function AnswersPage({ id }: { id: string }) {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const local = ov.locals.find((l) => l.doc.id === id) ?? null
  const [remote, setRemote] = useState<VisitDoc | null>(null)
  const [failed, setFailed] = useState(false)
  const [photoId, setPhotoId] = useState<string | null>(null)
  const hasLocal = !!local
  useEffect(() => {
    if (hasLocal) return
    let alive = true
    void getVisit(id).then((v) => { if (alive) setRemote(stripServer(v)) }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [id, hasLocal])

  const doc = local?.doc ?? remote
  const back = () => ov.go({ kind: 'visit', id })

  if (!doc) {
    return (
      <>
        <Head title={C.title} onBack={back} />
        <div className={s.body}><div className={s.col}>
          {failed
            ? (
              <div className={`form-warn form-warn-amber ${s.msg}`} role="status">
                <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.visitMissing}</span></div>
              </div>
            )
            : <div className={s.loadingLine}><LoadingStatus>{C.visitLoading}</LoadingStatus></div>}
        </div></div>
      </>
    )
  }

  // photos not yet on the server wear the upload badge, as on the visit page
  const pending = new Set(local ? (local.base ? pendingUploads(local) : doc.photos.map((p) => p.id)) : [])
  const photo = photoId ? doc.photos.find((p) => p.id === photoId) ?? null : null
  const when = `${fmtDate(doc.visitedAt)} ${fmtWhen(doc.visitedAt).split(' ').pop()}`
  const empty = !doc.checklist && !doc.notes.trim() && doc.photos.length === 0 && doc.proposals.length === 0

  return (
    <>
      <Head title={doc.checklist?.title ?? C.noChecklist} sub={`${doc.object.name} · ${when}`} onBack={back} />
      <div className={s.body}>
        <div className={s.col}>
          {empty && <p className={s.lead}>{C.answersNone}</p>}
          <ChecklistSection doc={doc} readOnly pending={pending} title={C.checklistHead}
            onEdit={noop} onTakePhoto={noop} onOpenPhoto={setPhotoId} />
          <NotesSection doc={doc} readOnly onEdit={noop} />
          <PhotosSection doc={doc} readOnly pending={pending} onTakePhoto={noop} onOpenPhoto={setPhotoId} />
          <ProposalsSection doc={doc} readOnly onOpen={noop} onAdd={noop} />
        </div>
      </div>
      {photo && (
        <PhotoSheet visitId={doc.id} photo={photo} preparing={false} stored={null} items={checklistItems(doc.checklist)} readOnly
          onCaption={noop} onItem={noop} onRemove={noop} onAnother={noop} onClose={() => setPhotoId(null)} />
      )}
    </>
  )
}
