// The two sheets of a visit: Foto (caption + what it belongs to, right after the camera) and
// Korrekturvorschlag. Phone bottom sheets through lib/overlays (Sheet, SheetFoot by `footer`).

import { useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { Sheet } from '../../lib/overlays'
import { LoadingStatus } from '../ShellLoader'
import { Segmented } from '../Segmented'
import type { Item } from '../../lib/checklists'
import { newId } from '../../lib/ids'
import type { ProposalField, VisitPhoto, VisitProposal } from '../../objectVisits/types'
import { usePhotoUrl } from './ovFormat'
import s from './ObjectVisits.module.css'

export function PhotoSheet({ visitId, photo, preparing, stored, items, readOnly, onCaption, onItem, onRemove, onAnother, onClose }: {
  visitId: string
  /** null while the camera's file is being prepared */
  photo: VisitPhoto | null
  preparing: boolean
  /** true = the photo is in IndexedDB; false = only in this window; null = not known (an older photo) */
  stored: boolean | null
  items: Item[]
  readOnly: boolean
  onCaption: (caption: string) => void
  onItem: (itemId: string | null) => void
  onRemove: () => void
  onAnother: () => void
  onClose: () => void
}) {
  const C = appConfig.copy.objectVisits
  const GENERAL = '__general__'
  const options = [{ value: GENERAL, label: C.photoGeneral }, ...items.map((i) => ({ value: i.id, label: i.text }))]
  const current = photo?.item ?? GENERAL
  const setItem = (v: string) => onItem(v === GENERAL ? null : v)
  return (
    <Sheet
      open
      onClose={onClose}
      title={C.photoTitle}
      footer={readOnly ? undefined : (
        <>
          <button type="button" className="ip-btn" onClick={onAnother} disabled={preparing}><Icon id="cam" />{C.photoAnother}</button>
          <button type="button" className="ip-btn primary" onClick={onClose}>{C.photoDone}</button>
        </>
      )}
    >
      {preparing || !photo
        ? <div className={s.preview}><div className={s.loadingLine}><LoadingStatus>{C.photoPreparing}</LoadingStatus></div></div>
        : <PhotoPreview visitId={visitId} attId={photo.id} alt={photo.caption} />}
      {photo && (readOnly
        ? (photo.caption && <p className={s.sumText} style={{ color: 'var(--ink)' }}>{photo.caption}</p>)
        : (
          <>
            <label className="ip-field">
              <span>{C.photoCaption}</span>
              <input className={s.input} value={photo.caption} placeholder={C.photoCaptionPlaceholder} maxLength={300}
                onChange={(e) => onCaption(e.target.value)} />
            </label>
            {items.length > 0 && (
              <div className="ip-field">
                <span>{C.photoBelongs}</span>
                {options.length <= 4
                  ? <Segmented ariaLabel={C.photoBelongs} options={options} value={current} onChange={setItem} />
                  : (
                    <select className={`ip-input ${s.select}`} value={current} aria-label={C.photoBelongs} onChange={(e) => setItem(e.target.value)}>
                      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  )}
              </div>
            )}
            {stored === true && <p className={s.storedOk}><Icon id="check" />{C.photoStored}</p>}
            {stored === false && (
              <p className="form-warn form-warn-compact"><Icon id="warn" /><span className="form-warn-text">{C.photoNotStored}</span></p>
            )}
            <button type="button" className="ip-btn ip-btn-danger" onClick={onRemove}><Icon id="trash" />{C.photoRemove}</button>
          </>
        ))}
    </Sheet>
  )
}

function PhotoPreview({ visitId, attId, alt }: { visitId: string; attId: string; alt: string }) {
  const { url, fallback } = usePhotoUrl(visitId, attId, { full: true })
  // offline, the full picture of a released photo cannot load: the thumbnail on the device stands in
  const [failed, setFailed] = useState<string | null>(null)
  const src = failed === url && fallback ? fallback : url
  return <div className={s.preview}>{src && <img src={src} alt={alt} onError={() => setFailed(url)} />}</div>
}

const OTHER = '__other__'

export function ProposalSheet({ proposal, fields, asOf, onSave, onRemove, onClose }: {
  /** null = a new one */
  proposal: VisitProposal | null
  fields: ProposalField[]
  /** the catalogue's date — the «Bisher» value was true as of then */
  asOf: string | null
  onSave: (p: VisitProposal) => void
  onRemove?: (p: VisitProposal) => void
  onClose: () => void
}) {
  const C = appConfig.copy.objectVisits
  const known = proposal ? fields.find((f) => f.id === proposal.field) : undefined
  const [field, setField] = useState<string>(proposal ? (known ? known.id : OTHER) : fields[0]?.id ?? OTHER)
  const [otherLabel, setOtherLabel] = useState(proposal && !known ? proposal.label : '')
  const [current, setCurrent] = useState(proposal?.current ?? '')
  const [proposed, setProposed] = useState(proposal?.proposed ?? '')
  const [reason, setReason] = useState(proposal?.reason ?? '')
  const options = [...fields.map((f) => ({ value: f.id, label: f.label })), { value: OTHER, label: C.proposalOther }]
  const label = field === OTHER ? otherLabel.trim() : fields.find((f) => f.id === field)?.label ?? ''
  const valid = !!label && !!proposed.trim()

  const save = () => {
    if (!valid) return
    onSave({
      id: proposal?.id ?? newId('ovp'),
      field: field === OTHER ? 'other' : field,
      label,
      ...(current.trim() ? { current: current.trim() } : {}),
      proposed: proposed.trim(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      base: proposal?.base ?? { source: 'kp-front', asOf },
    })
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={C.proposalTitle}
      footer={(
        <>
          {proposal && onRemove && (
            <button type="button" className="ip-btn ip-btn-danger" onClick={() => onRemove(proposal)} aria-label={C.proposalRemove}><Icon id="trash" /></button>
          )}
          <button type="button" className="ip-btn primary" disabled={!valid} onClick={save}>{C.proposalSave}</button>
        </>
      )}
    >
      <div className="ip-field">
        <span>{C.proposalField}</span>
        <Segmented ariaLabel={C.proposalField} options={options} value={field} onChange={setField} />
      </div>
      {field === OTHER && (
        <label className="ip-field">
          <span>{C.proposalOtherLabel}</span>
          <input className={s.input} value={otherLabel} onChange={(e) => setOtherLabel(e.target.value)} />
        </label>
      )}
      <label className="ip-field">
        <span>{`${C.proposalCurrent} (${C.proposalCurrentHint})`}</span>
        <input className={`${s.input} ${s.dashed}`} value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="ip-field">
        <span>{C.proposalNew}</span>
        <input className={s.input} value={proposed} onChange={(e) => setProposed(e.target.value)} />
      </label>
      <label className="ip-field">
        <span>{C.proposalReason}</span>
        <input className={s.input} value={reason} placeholder={C.proposalReasonPlaceholder} onChange={(e) => setReason(e.target.value)} />
      </label>
    </Sheet>
  )
}
