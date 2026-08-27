import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { Overlay } from '../lib/overlays'
import type { PlanDocument } from '../types'
import s from './GeorefMode.module.css'

export interface GeorefTransferTarget {
  plan: PlanDocument
  linked: boolean
}

/** Source → target picker for sibling Modules of one Einsatzobjekt.
 *
 *  It is modal because choosing a target writes station data immediately. The source remains
 *  visible in the explanatory sentence, so «which Passung am I copying?» never depends on the
 *  board still being recognisable behind the scrim. */
export function GeorefTransfer({ source, targets, onTransfer, onClose, onDone }: {
  source: PlanDocument
  targets: GeorefTransferTarget[]
  onTransfer: (target: GeorefTransferTarget) => Promise<boolean>
  onClose: () => void
  onDone?: () => void
}) {
  const C = appConfig.copy.whiteboard.georef
  const [busy, setBusy] = useState<string | null>(null)
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set())
  const close = () => { if (!busy) onClose() }

  const pick = async (target: GeorefTransferTarget) => {
    if (busy) return
    setBusy(target.plan.id)
    try {
      if (await onTransfer(target)) setCompleted((cur) => new Set(cur).add(target.plan.id))
    } finally { setBusy(null) }
  }

  return (
    <Overlay open onClose={close} className="ip-sheet ip-fit ui-dialog" ariaLabel={C.transferTitle}>
      <div className="ip-head">
        <h2>{C.transferTitle}</h2>
        <button className="ip-x" disabled={busy != null} onClick={close} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ip-body">
        <p className={s.transferBody}>{fillTemplate(C.transferBody, { source: source.code })}</p>
        <div className={s.transferList}>
          {targets.map((target) => (
            <button
              key={target.plan.id}
              className={s.transferRow}
              disabled={busy != null || completed.has(target.plan.id)}
              onClick={() => void pick(target)}
            >
              <span className={s.transferIcon}><Icon id="copy" /></span>
              <span className={s.transferName}><b>{target.plan.code}</b><small>{target.plan.title}</small></span>
              {completed.has(target.plan.id)
                ? <span className={s.transferLinked}>{C.transferCompleted}</span>
                : target.linked && <span className={s.transferLinked}>{C.transferLinked}</span>}
              {busy === target.plan.id && <Icon id="rotate" className="spin" />}
            </button>
          ))}
        </div>
      </div>
      <div className="ip-actions">
        <button className={`btn ${completed.size ? 'primary' : ''}`} disabled={busy != null}
          onClick={completed.size ? onDone ?? onClose : close}>{completed.size ? C.done : C.cancel}</button>
      </div>
    </Overlay>
  )
}
