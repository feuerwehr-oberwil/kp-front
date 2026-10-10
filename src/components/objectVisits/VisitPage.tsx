// Besuch: ONE page — head, status line, checklist, Bemerkungen, Fotos, Korrekturvorschläge — and
// one primary action, «Abschliessen» (design PLAN §2.4). Completed: the read view with the report,
// «Bearbeiten» (a correction: stays completed, new revision) and the Verlauf of revisions.
//
// Every edit is stored on the device AT ONCE (store · updateVisit); a revision goes to the server
// only at a save point: leaving, the app going to the background, «Abschliessen», «Jetzt senden»,
// and every 2 minutes while there are unsent edits (docs/object-visits.md · Save points).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../../lib/icons'
import { Button, IconButton } from '../Button'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { newId } from '../../lib/ids'
import { confirmDialog, toast, undoToast } from '../../lib/ui'
import { Menu } from '../../lib/overlays'
import { localThumb, prepareUploadImage } from '../../lib/imagePrep'
import { LoadingStatus } from '../ShellLoader'
import { getRevisions, getVisit, sha256Hex } from '../../objectVisits/api'
import { knownVisits, lastSeen, listProgress, resolveObject, visitTemplates } from '../../objectVisits/catalogue'
import { answerStats, checklistItems, stripServer, switchChecklist, syncPhotoAnswers } from '../../objectVisits/doc'
import { resolveConflict, type Resolution } from '../../objectVisits/merge'
import {
  adoptServerVisit, flushVisit, isFlushing, pendingUploads, requestSave, subscribeFlushing, type FlushOutcome,
} from '../../objectVisits/outbox'
import { downloadReport, exportVisitFile, visitText } from '../../objectVisits/report'
import { deriveStatus } from '../../objectVisits/status'
import {
  forgetVisit, isVisitDurable, onVisitChanged, putAttachment, readVisit, retryHeld, updateVisit, type LocalVisit,
} from '../../objectVisits/store'
import { personName, type Revision, type ServerVisit, type VisitDoc, type VisitPhoto, type VisitProposal, type VisitTemplate } from '../../objectVisits/types'
import { Head } from './common'
import { fmtDate, fmtWhen, lifecycleLabel, plural } from './ovFormat'
import { ChecklistSheet, PhotoSheet, ProposalSheet } from './Sheets'
import { PlanReader, PlansCard } from './PlansCard'
import { usePlanReader, useVisitPlans } from './usePlans'
import { AuthCard, ConflictCards, RefusedCard, UnsavedCard } from './StateCards'
import { StatusLine } from './StatusLine'
import { ChecklistSection, DetailsCard, NotesSection, PhotosSection, ProposalsSection, SummaryCard } from './VisitSections'
import { useOv } from './ovContext'
import s from './ObjectVisits.module.css'

/** «every 2 min while dirty» */
const DIRTY_SAVE_MS = 120_000
/** a save point this long after the last change (owner, staging 03.10.2026: «make sending automatic») */
export const QUIET_SAVE_MS = 20_000
/** how often an open, sent visit asks the server about its filing while that is pending */
const DELIVERY_POLL_MS = 60_000

export function VisitPage({ id }: { id: string }) {
  const ov = useOv()
  const C = appConfig.copy.objectVisits
  const [rec, setRec] = useState<LocalVisit | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing' | 'unreadable'>('loading')
  const [remote, setRemote] = useState<ServerVisit | null>(null)
  const [durable, setDurable] = useState(true)
  const [correcting, setCorrecting] = useState(false)
  const [photoSheet, setPhotoSheet] = useState<{ attId: string | null; preparing: boolean; stored: boolean | null } | null>(null)
  const [proposalSheet, setProposalSheet] = useState<{ p: VisitProposal | null } | null>(null)
  const [checklistSheet, setChecklistSheet] = useState(false)
  const reader = usePlanReader()
  const [revisions, setRevisions] = useState<Revision[] | 'loading' | 'failed' | null>(null)
  const flushing = useSyncExternalStore(subscribeFlushing, () => isFlushing(id), () => false)
  const pendingEdits = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const photoItemRef = useRef<string | null>(null)
  // read inside the load effect without re-running it
  const who = useRef({ canCapture: ov.canCapture, userId: ov.userId })
  useEffect(() => { who.current = { canCapture: ov.canCapture, userId: ov.userId } }, [ov.canCapture, ov.userId])

  // ── the device copy, the server's copy ──
  useEffect(() => {
    let alive = true
    const load = async (): Promise<LocalVisit | null | 'unreadable'> => {
      const r = await readVisit(id)
      if (!alive) return null
      if (!r.ok) { setPhase((p) => (p === 'ready' ? p : 'unreadable')); return 'unreadable' }
      // a reload while this page has edits in flight would put an older copy under the caret
      if (r.value && pendingEdits.current === 0) {
        setRec(r.value)
        setDurable(isVisitDurable(id, r.value.doc))
        setPhase('ready')
      }
      return r.value
    }
    const refresh = async (local: LocalVisit | null) => {
      // a draft that never left this device has nothing on the server to ask about
      if (local && !local.base) return
      try {
        const v = await getVisit(id)
        if (!alive) return
        if (local || who.current.canCapture) await adoptServerVisit(v, who.current.userId) // → onVisitChanged → load
        else { setRemote(v); setPhase('ready') }
      } catch {
        if (alive && !local) setPhase((p) => (p === 'ready' ? p : 'missing'))
      }
    }
    void load().then((local) => { if (alive && local !== 'unreadable') void refresh(local) })
    const off = onVisitChanged((changed) => { if (changed === id) void load() })
    return () => { alive = false; off() }
  }, [id])

  // ── save points: background, every 2 min while dirty, and leaving ──
  useEffect(() => {
    const save = () => requestSave(id, undefined, { actor: who.current.userId })
    const onHidden = () => { if (document.visibilityState === 'hidden') void save() }
    document.addEventListener('visibilitychange', onHidden)
    // the page going away (a reload, the app swiped off) — best effort, like the background
    window.addEventListener('pagehide', save)
    const t = setInterval(() => {
      void readVisit(id).then((r) => { if (r.ok && r.value?.dirty) void save() })
    }, DIRTY_SAVE_MS)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', save)
      clearInterval(t)
      void save() // leaving the visit
    }
  }, [id])

  const doc: VisitDoc | null = rec?.doc ?? (remote ? stripServer(remote) : null)
  const status = deriveStatus({ rec, durable, flushing, sessionExpired: ov.sessionExpired, remote })
  const plans = useVisitPlans(doc?.object.id)

  // ── while the filing is pending, ask now and then (the worker runs every 30 s) ──
  const pollDelivery = !!rec?.base && (status.delivery.kind === 'waiting')
  useEffect(() => {
    if (!pollDelivery) return
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void getVisit(id).then((v) => adoptServerVisit(v, who.current.userId)).catch(() => {})
    }, DELIVERY_POLL_MS)
    return () => clearInterval(t)
  }, [pollDelivery, id])

  // ── a save point 20 s after the last change while online: nobody has to think about sending ──
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (quietTimer.current) clearTimeout(quietTimer.current) }, [])
  const armQuietSave = useCallback(() => {
    if (quietTimer.current) clearTimeout(quietTimer.current)
    quietTimer.current = setTimeout(() => {
      quietTimer.current = null
      // offline too: the send fails at once, and the save point it leaves behind is what the
      // reconnect sends (outbox · startOutboxRunner) — the member never has to come back for it
      void requestSave(id, undefined, { actor: who.current.userId })
    }, QUIET_SAVE_MS)
  }, [id])

  /** Store an edit on the device now; the page shows it before the write lands. */
  const edit = useCallback((fn: (d: VisitDoc) => VisitDoc): Promise<void> => {
    pendingEdits.current++
    armQuietSave()
    setRec((r) => (r ? { ...r, doc: syncPhotoAnswers(fn(r.doc)), dirty: true } : r))
    return updateVisit(id, (cur) => (cur ? {
      ...cur,
      doc: syncPhotoAnswers(fn(cur.doc)),
      dirty: true,
      // a refused document — or a refused photo — is answered by editing: the next save point
      // tries again
      ...(cur.lastError?.kind === 'rejected' || cur.lastError?.kind === 'attachment' ? { lastError: null } : {}),
      ...(cur.refusedPhotos && Object.keys(cur.refusedPhotos).length ? { refusedPhotos: {} } : {}),
    } : null), { queueOnFailure: true }).then((res) => {
      pendingEdits.current--
      // a failed READ queued the edit (store · queuedEdits): the page keeps showing it, and the
      // visit says «Nicht gespeichert» until it has landed
      setDurable(res.ok && res.durable && isVisitDurable(id, res.rec?.doc))
      if (pendingEdits.current === 0 && res.rec) setRec(res.rec)
    })
  }, [id, armQuietSave])

  const sendNow = async () => {
    const out = await requestSave(id, undefined, { actor: ov.userId, manual: true })
    sayOutcome(out)
  }
  const sayOutcome = (out: FlushOutcome, lead?: string) => {
    if (out === 'offline') toast(lead ? `${lead} · ${C.sendOffline}` : C.sendOffline, { icon: 'warn' })
    else if (out === 'contended') toast(lead ? `${lead} · ${C.sendContended}` : C.sendContended, { icon: 'warn', tone: 'warn' })
    else if (out === 'done' || out === 'nothing') toast(lead ?? C.sent, { icon: 'check', tone: 'success' })
    else if (lead) toast(lead, { icon: 'check' })
  }

  const saveFile = async () => {
    const cur = rec ?? (doc ? { doc, base: null, dirty: false, savedAt: new Date().toISOString(), sent: null, lastError: null } as LocalVisit : null)
    if (!cur) return
    try {
      const words = { check: C.answer as Record<string, string>, open: C.notChecked, notes: C.notes, proposals: C.proposals }
      const { missingPhotos } = await exportVisitFile(cur, visitText(cur.doc, words))
      toast(missingPhotos ? fillTemplate(C.fileSavedMissing, { n: missingPhotos }) : C.fileSaved, { icon: 'download' })
    } catch {
      toast(C.fileFailed, { icon: 'warn', tone: 'warn' })
    }
  }

  // ── photos ──
  const takePhoto = (itemId: string | null) => {
    photoItemRef.current = itemId
    fileRef.current?.click()
  }
  /** One picked file → one photo on the device (prepared, thumbnailed, hashed). Null when the
   *  browser could not decode it. */
  const storePhoto = async (file: File, itemId: string | null, caption: string): Promise<{ photo: VisitPhoto; stored: boolean } | null> => {
    try {
      const blob = await prepareUploadImage(file)
      const type = blob.type || 'image/jpeg'
      const thumb = await localThumb(blob).catch(() => null)
      const sha256 = await sha256Hex(blob)
      const attId = newId('ova')
      const stored = await putAttachment(attId, { blob, thumb, type, sha256, size: blob.size, visitId: id })
      return { photo: { id: attId, caption, ...(itemId ? { item: itemId } : {}), sha256, size: blob.size, type }, stored }
    } catch {
      return null
    }
  }
  /** The picker answered: the camera's one photo (its caption sheet follows), or several from the
   *  library — all added at once with empty captions, linked to the item the picker came from. */
  const onFiles = async (files: File[]) => {
    const itemId = photoItemRef.current
    if (files.length === 1) {
      setPhotoSheet({ attId: null, preparing: true, stored: null })
      const item = itemId ? checklistItems(doc?.checklist).find((i) => i.id === itemId) : undefined
      const got = await storePhoto(files[0], itemId, item?.text ?? '')
      if (!got) { setPhotoSheet(null); toast(C.photoFailed, { icon: 'warn', tone: 'warn' }); return }
      await edit((d) => ({ ...d, photos: [...d.photos, got.photo] }))
      setPhotoSheet({ attId: got.photo.id, preparing: false, stored: got.stored })
    } else {
      setPhotoSheet(null)
      const added: VisitPhoto[] = []
      let failed = 0
      for (const f of files) { // one at a time: imagePrep decodes one picture at a time anyway
        const got = await storePhoto(f, itemId, '')
        if (got) added.push(got.photo); else failed++
      }
      if (added.length) await edit((d) => ({ ...d, photos: [...d.photos, ...added] }))
      if (added.length) toast(fillTemplate(C.photosAdded, { n: added.length }), { icon: 'check' })
      if (failed) toast(C.photoFailed, { icon: 'warn', tone: 'warn' })
    }
    // photos go up as soon as the visit exists on the server (not a revision)
    if (rec?.base) void flushVisit(id) // (its pending send stays with its account — outbox · responsible)
  }

  const removePhoto = (attId: string) => {
    if (!doc) return
    const at = doc.photos.findIndex((p) => p.id === attId)
    const gone = doc.photos[at]
    if (!gone) return
    setPhotoSheet(null)
    void edit((d) => ({ ...d, photos: d.photos.filter((p) => p.id !== attId) }))
    undoToast(C.photoRemoved, () => {
      void edit((d) => (d.photos.some((p) => p.id === attId) ? d : { ...d, photos: [...d.photos.slice(0, at), gone, ...d.photos.slice(at)] }))
    })
  }

  // ── proposals ──
  const saveProposal = (p: VisitProposal) => {
    setProposalSheet(null)
    void edit((d) => ({ ...d, proposals: d.proposals.some((x) => x.id === p.id) ? d.proposals.map((x) => (x.id === p.id ? p : x)) : [...d.proposals, p] }))
  }
  const removeProposal = (p: VisitProposal) => {
    if (!doc) return
    const at = doc.proposals.findIndex((x) => x.id === p.id)
    setProposalSheet(null)
    void edit((d) => ({ ...d, proposals: d.proposals.filter((x) => x.id !== p.id) }))
    undoToast(C.proposalRemoved, () => {
      void edit((d) => (d.proposals.some((x) => x.id === p.id) ? d : { ...d, proposals: [...d.proposals.slice(0, at), p, ...d.proposals.slice(at)] }))
    })
  }

  const resolve = (conflictId: string, how: Resolution) => { void edit((d) => resolveConflict(d, conflictId, how)) }

  // ── lifecycle ──
  const complete = async () => {
    if (!doc) return
    const st = answerStats(doc)
    if (st.open > 0) {
      const req = st.requiredOpen.map((i) => i.text).join(', ')
      const ok = await confirmDialog({
        title: plural(st.open, C.completeOpenOne, C.completeOpenMany),
        message: req ? `${C.completeOpenMsg}\n${fillTemplate(C.completeRequired, { items: req })}` : C.completeOpenMsg,
        confirmLabel: C.completeAnyway,
      })
      if (!ok) return
    }
    await edit((d) => ({ ...d, lifecycle: 'completed' }))
    sayOutcome(await requestSave(id, undefined, { actor: ov.userId }), C.completed)
  }
  const finishCorrection = async () => {
    setCorrecting(false)
    sayOutcome(await requestSave(id, undefined, { actor: ov.userId }))
  }
  /** «Checkliste wechseln» (a draft only — the server refuses a changed snapshot after that) */
  const changeChecklist = async (t: VisitTemplate | null) => {
    setChecklistSheet(false)
    const cur = rec?.doc
    if (!cur || cur.lifecycle !== 'draft') return
    if ((t?.id ?? null) === (cur.checklist?.id ?? null) && (t == null || (t.version ?? 0) === (cur.checklist?.version ?? 0))) return
    const { dropped } = switchChecklist(cur, t)
    if (dropped > 0) {
      const ok = await confirmDialog({
        title: C.changeChecklist, message: plural(dropped, C.changeChecklistDropOne, C.changeChecklistDropMany), confirmLabel: C.changeChecklistConfirm,
      })
      if (!ok) return
    }
    await edit((d) => switchChecklist(d, t).doc)
  }
  const discard = async () => {
    const ok = await confirmDialog({ title: C.discardTitle, message: C.discardMsg, confirmLabel: C.discardBtn, danger: true })
    if (!ok) return
    // never on the server: confirmed, so nothing of it stays on the device either
    if (rec && !rec.base && !rec.op) {
      await forgetVisit(id)
      leave()
      return
    }
    await edit((d) => ({ ...d, lifecycle: 'discarded' }))
    void requestSave(id, undefined, { actor: ov.userId })
    leave()
  }

  const catalogue = ov.cat && (ov.cat.state === 'ready' || ov.cat.state === 'stale') ? ov.cat.catalogue : null
  const list = doc?.workRef ? catalogue?.lists.find((l) => l.ref === doc.workRef) ?? null : null
  const leave = () => (list ? ov.go({ kind: 'list', ref: list.ref }) : ov.go({ kind: 'overview' }))

  if (!doc) {
    return (
      <>
        <Head title={C.title} onBack={leave} />
        <div className={s.body}>
          <div className={s.col}>
            {phase === 'loading' && <div className={s.loadingLine}><LoadingStatus>{C.visitLoading}</LoadingStatus></div>}
            {(phase === 'missing' || phase === 'unreadable') && (
              <div className={`form-warn form-warn-amber ${s.msg}`} role="status">
                <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.visitMissing}</span></div>
              </div>
            )}
          </div>
        </div>
      </>
    )
  }

  const lifecycle = doc.lifecycle
  const canEdit = ov.canCapture && !!rec && lifecycle !== 'discarded'
  const editable = canEdit && (lifecycle === 'draft' || correcting)
  const readView = !editable
  const catObject = catalogue ? resolveObject(catalogue, doc.object.id) : null
  const seen = catalogue && catObject && catObject.lastVisit?.id !== doc.id ? lastSeen(catalogue, catObject) : null
  const last = seen ? fillTemplate(C.lastVisit, { date: fmtDate(seen.at) }) : null
  const sub = [doc.object.address, last].filter(Boolean).join(' · ')
  const pending = new Set(rec ? (rec.base ? pendingUploads(rec) : doc.photos.map((p) => p.id)) : [])
  const revision = rec?.base?.revision ?? remote?.revision ?? null
  const byName = personName(rec?.server?.createdBy ?? remote?.createdBy ?? null) || null
  const photo = photoSheet?.attId ? doc.photos.find((p) => p.id === photoSheet.attId) ?? null : null
  const sheetItems = checklistItems(doc.checklist)
  const templates = catalogue ? visitTemplates(catalogue) : []

  // the next stop of the work list: the first object after this one without a completed visit
  const next = (() => {
    if (!list || !catalogue || lifecycle !== 'completed') return null
    // done = a completed visit for this list, or the organizer's prior completion
    const stops = listProgress(list, knownVisits(ov.locals, ov.summaries)).stops
    const at = list.objectIds.indexOf(doc.object.id)
    const order = [...list.objectIds.slice(at + 1), ...list.objectIds.slice(0, Math.max(0, at))]
    const id2 = order.find((oid) => oid !== doc.object.id && !stops.get(oid)?.done && catalogue.objects.some((o) => o.id === oid))
    if (!id2) return 'done' as const
    return { index: list.objectIds.indexOf(id2) + 1, object: catalogue.objects.find((o) => o.id === id2)! }
  })()

  const openRevisions = () => {
    if (revisions && revisions !== 'failed') { setRevisions(null); return }
    setRevisions('loading')
    void getRevisions(id).then((r) => setRevisions([...r].sort((a, b) => b.revision - a.revision))).catch(() => setRevisions('failed'))
  }
  const report = (n?: number) => { void downloadReport(doc, n).catch(() => toast(C.reportFailed, { icon: 'warn', tone: 'warn' })) }


  return (
    <>
      <Head
        title={doc.object.name}
        subNode={<StatusLine status={status} rec={rec} canSend={canEdit} onSendNow={() => { void sendNow() }} />}
        onBack={leave}
        actions={canEdit && lifecycle === 'draft' ? (
          <Menu
            trigger={<IconButton label={C.menu}><Icon id="more" /></IconButton>}
            popupClassName={s.menuPop}
            itemClassName={() => s.menuItem}
            // sending is automatic and «Als Datei sichern» lives in the cards that need it: the
            // menu holds the one thing that is not a save (owner, staging 03.10.2026)
            items={[
              ...(templates.length ? [{ label: C.changeChecklist, onClick: () => setChecklistSheet(true) }] : []),
              { label: C.discard, onClick: () => { void discard() }, danger: true },
            ]}
          />
        ) : undefined}
      />
      <div className={s.body}>
        <div className={s.col}>
          {sub && <p className={s.place}><Icon id="pin" />{sub}</p>}

          {status.sync.kind === 'unsaved' && (
            <UnsavedCard onSaveFile={() => { void saveFile() }}
              onRetry={() => { void retryHeld().then(() => setDurable(isVisitDurable(id, rec?.doc))) }} />
          )}
          {status.sync.kind === 'auth' && <AuthCard onLogin={ov.relogin} onSaveFile={() => { void saveFile() }} />}
          {status.sync.kind === 'error' && status.sync.error && <RefusedCard error={status.sync.error} onSaveFile={() => { void saveFile() }} />}
          <ConflictCards doc={doc} readOnly={!canEdit} viewer={ov.userId} onResolve={resolve} />

          {lifecycle === 'completed' && !correcting && (
            <>
              <SummaryCard doc={doc} byName={byName} />
              <div className={s.card}>
                {revision != null && (
                  <button type="button" className={s.row} onClick={() => report()}>
                    <Icon id="doc" className={s.rowGlyph} />
                    <span className={s.rowMain}>
                      <span className={s.rowTitle}>{C.report}</span>
                      <span className={s.rowSub}>{fillTemplate(C.reportSub, { n: revision })}</span>
                    </span>
                    <Icon id="chevron" className={s.chev} />
                  </button>
                )}
                {canEdit && (
                  <button type="button" className={s.row} onClick={() => setCorrecting(true)}>
                    <Icon id="pen" className={s.rowGlyph} />
                    <span className={s.rowMain}>
                      <span className={s.rowTitle}>{C.edit}</span>
                      <span className={s.rowSub}>{C.editSub}</span>
                    </span>
                    <Icon id="chevron" className={s.chev} />
                  </button>
                )}
                {revision != null && (
                  <button type="button" className={s.row} onClick={openRevisions} aria-expanded={!!revisions && revisions !== 'failed'}>
                    <Icon id="history" className={s.rowGlyph} />
                    <span className={s.rowMain}>
                      <span className={s.rowTitle}>{C.history}</span>
                      {revisions === 'failed' && <span className={s.rowSub}>{C.historyFailed}</span>}
                    </span>
                    <Icon id="chevron-down" className="chev" />
                  </button>
                )}
                {revisions === 'loading' && <div className={s.loadingLine}><LoadingStatus>{C.visitLoading}</LoadingStatus></div>}
                {Array.isArray(revisions) && revisions.map((r) => (
                  <button key={r.revision} type="button" className={s.row} onClick={() => report(r.revision)}>
                    <span className={s.num}>{r.revision}</span>
                    <span className={s.rowMain}>
                      <span className={s.rowTitle}>{fillTemplate(C.historyRow, { n: r.revision, time: `${fmtDate(r.acceptedAt)} ${fmtWhen(r.acceptedAt).split(' ').pop()}` })}</span>
                      <span className={s.rowSub}>{[lifecycleLabel(r.lifecycle), personName(r.acceptedBy)].filter(Boolean).join(' · ')}</span>
                    </span>
                    <Icon id="doc" className={s.chev} />
                  </button>
                ))}
              </div>
              {next === 'done' && <p className={s.secNote}>{C.listDone}</p>}
              {next && next !== 'done' && (
                <>
                  <h2 className={s.sec}>{C.nextInList}</h2>
                  <div className={s.card}>
                    <button type="button" className={s.row} onClick={() => ov.go({ kind: 'new', object: next.object.id, ref: list!.ref })}>
                      <span className={s.num}>{next.index}</span>
                      <span className={s.rowMain}>
                        <span className={s.rowTitle}>{next.object.name}</span>
                        <span className={s.rowSub}>{[next.object.address, next.object.lastVisit?.lifecycle === 'completed' ? fillTemplate(C.lastVisit, { date: fmtDate(next.object.lastVisit.visitedAt) }) : C.neverVisited].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Icon id="chevron" className={s.chev} />
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {correcting && (
            <p className="form-warn form-warn-amber form-warn-compact"><Icon id="pen" /><span className="form-warn-text">{C.correctionNote}</span></p>
          )}

          <DetailsCard doc={doc} readOnly={readView} onEdit={(fn) => { void edit(fn) }} />
          <PlansCard rows={plans} onOpen={reader.open} />
          <ChecklistSection doc={doc} readOnly={readView} pending={pending}
            onEdit={(fn) => { void edit(fn) }} onTakePhoto={takePhoto}
            onOpenPhoto={(attId) => setPhotoSheet({ attId, preparing: false, stored: null })} />
          <NotesSection doc={doc} readOnly={readView} onEdit={(fn) => { void edit(fn) }} />
          <PhotosSection doc={doc} readOnly={readView} pending={pending} onTakePhoto={takePhoto}
            onOpenPhoto={(attId) => setPhotoSheet({ attId, preparing: false, stored: null })} />
          <ProposalsSection doc={doc} readOnly={readView}
            onOpen={(p) => setProposalSheet({ p })} onAdd={() => setProposalSheet({ p: null })} />
        </div>
      </div>

      {editable && (
        <div className={s.foot}>
          <div className={s.footRow}>
            {lifecycle === 'draft'
              ? <Button variant="primary" size="lg" icon={<Icon id="check" />} onClick={() => { void complete() }}>{C.complete}</Button>
              : <Button variant="primary" size="lg" icon={<Icon id="check" />} onClick={() => { void finishCorrection() }}>{C.correctionDone}</Button>}
          </div>
        </div>
      )}

      <input
        // no `capture`: the phone offers camera AND library (iOS: Kamera · Fotomediathek ·
        // Dateien); several picked at once become several photos
        ref={fileRef} className={s.hiddenInput} type="file" accept="image/*" multiple
        data-testid="ov-photo-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void onFiles(files)
        }}
      />

      {photoSheet && (
        <PhotoSheet
          visitId={id}
          photo={photo}
          preparing={photoSheet.preparing}
          stored={photoSheet.stored}
          items={sheetItems}
          readOnly={!editable}
          onCaption={(caption) => { const a = photoSheet.attId; void edit((d) => ({ ...d, photos: d.photos.map((p) => (p.id === a ? { ...p, caption } : p)) })) }}
          onItem={(itemId) => {
            const a = photoSheet.attId
            void edit((d) => ({
              ...d,
              photos: d.photos.map((p) => {
                if (p.id !== a) return p
                const q = { ...p }
                if (itemId) q.item = itemId
                else delete q.item
                return q
              }),
            }))
          }}
          onRemove={() => { if (photoSheet.attId) removePhoto(photoSheet.attId) }}
          onAnother={() => takePhoto(photo?.item ?? null)}
          onClose={() => setPhotoSheet(null)}
        />
      )}
      {proposalSheet && (
        <ProposalSheet
          proposal={proposalSheet.p}
          fields={catalogue?.proposalFields ?? []}
          asOf={catalogue?.generatedAt ?? null}
          onSave={saveProposal}
          onRemove={removeProposal}
          onClose={() => setProposalSheet(null)}
        />
      )}
      {checklistSheet && (
        <ChecklistSheet templates={templates} current={doc.checklist}
          onPick={(t) => { void changeChecklist(t) }} onClose={() => setChecklistSheet(false)} />
      )}
      {reader.index != null && plans.length > 0 && (
        <PlanReader rows={plans} index={reader.index} objectName={doc.object.name} onShow={reader.show} onClose={reader.close} />
      )}
    </>
  )
}
