// The cards a visit shows when something needs a hand: «Zwei Fassungen», «Nicht gespeichert»,
// «Anmeldung abgelaufen», «nicht angenommen». Each is the .form-warn recipe with its actions.

import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { conflictIsMine, isTextConflict, type Resolution } from '../../objectVisits/merge'
import type { OutboxError } from '../../objectVisits/store'
import type { VisitDoc } from '../../objectVisits/types'
import { conflictValue, conflictWhat } from './ovFormat'
import s from './ObjectVisits.module.css'

export function ConflictCards({ doc, readOnly, viewer, onResolve }: {
  doc: VisitDoc
  readOnly: boolean
  /** the signed-in account (with this device's id, it decides whose «Meine» a card is) */
  viewer: string | null
  onResolve: (conflictId: string, how: Resolution) => void
}) {
  const C = appConfig.copy.objectVisits
  return (
    <>
      {(doc.conflicts ?? []).map((c) => (
        <div key={c.id} className={`form-warn form-warn-amber ${s.msg}`} role="status">
          <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{fillTemplate(C.conflictTitle, { what: conflictWhat(c, doc) })}</span></div>
          <p className={s.msgBody}>{C.conflictBody}</p>
          {(() => {
            // «Meine» only on the device (and account) that met the collision — it travels in the
            // shared document, and on any other device «Meine» would name someone else's value
            const ours = conflictIsMine(c, viewer)
            const pickLabel = ours ? C.conflictMine : C.conflictTakeOther
            const keepLabel = ours ? C.conflictTheirs : C.conflictKeep
            return (
              <>
                <div className={s.versions}>
                  <div><b>{ours ? C.conflictMine : C.conflictOther}</b><span>{conflictValue(c, c.mine, doc)}</span></div>
                  <div><b>{ours ? C.conflictTheirs : C.conflictCurrent}</b><span>{conflictValue(c, c.theirs, doc)}</span></div>
                </div>
                {!readOnly && (
                  <div className={s.msgActs}>
                    <button type="button" className="form-warn-act" onClick={() => onResolve(c.id, 'mine')}>{pickLabel}</button>
                    <button type="button" className="form-warn-act" onClick={() => onResolve(c.id, 'theirs')}>{keepLabel}</button>
                    {isTextConflict(c) && (
                      <button type="button" className="form-warn-act" onClick={() => onResolve(c.id, 'both')}>{C.conflictBoth}</button>
                    )}
                  </div>
                )}
              </>
            )
          })()}
        </div>
      ))}
    </>
  )
}

export function UnsavedCard({ onSaveFile, onRetry }: { onSaveFile: () => void; onRetry: () => void }) {
  const C = appConfig.copy.objectVisits
  return (
    <div className={`form-warn ${s.msg}`} role="alert">
      <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{C.unsavedTitle}</span></div>
      <p className={s.msgBody}>{C.unsavedBody}</p>
      <div className={s.msgActs}>
        <button type="button" className="form-warn-act" onClick={onSaveFile}><Icon id="download" /> {C.saveFile}</button>
        <button type="button" className="form-warn-act" onClick={onRetry}>{C.unsavedRetry}</button>
      </div>
    </div>
  )
}

export function AuthCard({ onLogin, onSaveFile }: { onLogin: () => void; onSaveFile: () => void }) {
  const C = appConfig.copy.objectVisits
  return (
    <div className={`form-warn form-warn-amber ${s.msg}`} role="status">
      <div className={s.msgHead}><Icon id="lock" /><span className={s.msgTitle}>{C.authTitle}</span></div>
      <p className={s.msgBody}>{C.authBody}</p>
      <div className={s.msgActs}>
        <button type="button" className="form-warn-act" onClick={onLogin}>{C.authLogin}</button>
        <button type="button" className="form-warn-act" onClick={onSaveFile}><Icon id="download" /> {C.saveFile}</button>
      </div>
    </div>
  )
}

export function RefusedCard({ error, onSaveFile }: { error: OutboxError; onSaveFile: () => void }) {
  const C = appConfig.copy.objectVisits
  const title = error.kind === 'attachment' ? C.errorAttachment : C.errorTitle
  const body = error.kind === 'forbidden' ? C.errorForbidden : error.kind === 'disabled' ? C.errorDisabled : error.detail ?? ''
  return (
    <div className={`form-warn ${s.msg}`} role="alert">
      <div className={s.msgHead}><Icon id="warn" /><span className={s.msgTitle}>{title}</span></div>
      {body && <p className={s.msgBody}>{body}</p>}
      <div className={s.msgActs}>
        <button type="button" className="form-warn-act" onClick={onSaveFile}><Icon id="download" /> {C.saveFile}</button>
      </div>
    </div>
  )
}
