// The one status line of a visit — lifecycle · device → server · filing — and, on tap, the sheet
// that spells out all three (design PLAN §5). «Jetzt senden» lives there too: a save point.

import { useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Sheet } from '../../lib/overlays'
import type { VisitStatus } from '../../objectVisits/status'
import { destinationLabel } from '../../objectVisits/folders'
import { getDeploymentConfig } from '../../lib/deploymentConfig'
import type { LocalVisit } from '../../objectVisits/store'
import { deliveryLabel, fmtWhen, lifecycleLabel, syncLabel } from './ovFormat'
import s from './ObjectVisits.module.css'

const syncTone = (k: VisitStatus['sync']['kind']) =>
  k === 'saved' ? s.toneOk
    : k === 'unsaved' || k === 'error' ? s.toneBad
      : k === 'conflict' || k === 'auth' ? s.toneWarn
        : undefined

const syncIcon = (k: VisitStatus['sync']['kind']) =>
  k === 'unsaved' || k === 'error' || k === 'conflict' ? 'warn'
    : k === 'auth' ? 'lock'
      : k === 'local' || k === 'changes' ? 'clock'
        : k === 'saved' ? 'check'
          : 'upload'

export function StatusLine({ status, rec, canSend, onSendNow }: {
  status: VisitStatus
  rec: LocalVisit | null
  /** the sheet may offer «Erneut versuchen» (a capture role) — only when a send did NOT get
   *  through: sending is automatic (save points + 20 s after the last change), there is no
   *  «Jetzt senden» to think about otherwise (owner, staging 03.10.2026) */
  canSend: boolean
  onSendNow: () => void
}) {
  const C = appConfig.copy.objectVisits
  const [open, setOpen] = useState(false)
  const { lifecycle, sync, delivery } = status
  const filing = deliveryLabel(delivery)
  const lc = lifecycle === 'completed' ? `${s.lcDot} ${s.done}` : lifecycle === 'discarded' ? `${s.lcDot} ${s.gone}` : s.lcDot
  const line = [lifecycleLabel(lifecycle), syncLabel(sync), filing].filter(Boolean).join(' · ')

  const deviceText = (): string[] => {
    const out: string[] = []
    if (rec?.savedAt) out.push(fillTemplate(C.statusSavedAt, { time: fmtWhen(rec.savedAt) }))
    if (!rec?.base) out.push(C.statusNeverSent)
    else {
      out.push(fillTemplate(C.statusRevision, { n: rec.base.revision }))
      if (rec.dirty || rec.op) out.push(C.statusPending)
    }
    if (sync.kind === 'photos') out.push(fillTemplate(C.statusPhotos, { done: sync.photosDone ?? 0, total: sync.photosTotal ?? 0 }))
    if (sync.error?.detail) out.push(sync.error.detail)
    if (sync.offline) out.push(C.sendOffline)
    return out
  }

  return (
    <>
      {/* the second line of the page head: compact, one tap to the sheet */}
      <button type="button" className={s.headStatus} aria-label={`${C.statusOpen}: ${line}`} onClick={() => setOpen(true)}>
        <span className={s.seg}><span className={lc} aria-hidden />{lifecycleLabel(lifecycle)}</span>
        <span className={s.sep} aria-hidden>·</span>
        <span className={`${s.seg} ${syncTone(sync.kind) ?? ''}`}><Icon id={syncIcon(sync.kind)} />{syncLabel(sync)}</span>
        {filing && (
          <>
            <span className={s.sep} aria-hidden>·</span>
            <span className={`${s.seg} ${delivery.kind === 'failed' ? s.toneBad : delivery.kind === 'delivered' ? s.toneOk : ''}`}><Icon id="archive" />{filing}</span>
          </>
        )}
      </button>
      {open && (
        <Sheet
          open
          fit
          onClose={() => setOpen(false)}
          title={C.statusTitle}
          footer={canSend && (sync.error || sync.offline) && sync.kind !== 'auth' ? (
            <button type="button" className="ip-btn primary" onClick={() => { setOpen(false); onSendNow() }}>
              <Icon id="rotate" />{C.retry}
            </button>
          ) : undefined}
        >
          <div className={s.statusRows}>
            <div>
              <h3>{C.statusLifecycle}</h3>
              <p>{lifecycleLabel(lifecycle)}</p>
            </div>
            <div>
              <h3>{C.statusDevice}</h3>
              <p className={syncTone(sync.kind)}>{syncLabel(sync)}</p>
              {deviceText().map((t) => <p key={t}>{t}</p>)}
            </div>
            <div>
              <h3>{C.statusFiling}</h3>
              {delivery.kind === 'none'
                ? <p>{C.statusNoFiling}</p>
                : delivery.rows.map((d) => (
                  <p key={d.destination}>
                    {fillTemplate(C.statusFilingRow, { destination: destinationLabel(d.destination, getDeploymentConfig().objectVisits?.destinations, () => C.destinationSharePoint), state: appConfig.copy.admin.objectVisits.deliveryStates[d.state] ?? d.state })}
                    {d.error ? ` · ${d.error}` : ''}
                  </p>
                ))}
            </div>
          </div>
        </Sheet>
      )}
    </>
  )
}
