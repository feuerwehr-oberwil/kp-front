import { useMemo, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { buildLabel } from '../../lib/buildInfo'
import { getDeploymentConfig } from '../../lib/deploymentConfig'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import {
  buildReport, buildSubject, buildTechBlock, mailtoUrl, readEnv, type ReportInput,
} from '../../lib/feedbackReport'
import { markTroubleAsked, type TroubleEvent } from '../../lib/trouble'
import { Modal } from './_shared'

/** Rückmeldung composer. Opened either from Einstellungen (no `trouble`) or from the launcher
 *  prompt after something went wrong (`trouble` set, so the question can be specific).
 *
 *  Deliberately has no send button. The station owns its data, so the app writes the text and
 *  shows it in full; the operator decides whether it leaves the building and to whom. The
 *  technical block is rendered verbatim above the buttons for exactly that reason — «das wird
 *  mitgeschickt» is only credible if you can read it. */
export function FeedbackSheet({ trouble, onClose }: {
  trouble?: TroubleEvent
  onClose: () => void
}) {
  const cp = appConfig.copy.feedback
  const [message, setMessage] = useState('')

  // Snapshot once on open: the report should describe the moment the operator started writing,
  // not shift under them if the network flaps mid-sentence.
  const env = useMemo(() => readEnv(buildLabel(), appConfig.locale), [])
  const appName = getDeploymentConfig().identity?.appName ?? appConfig.appName

  const input: ReportInput = {
    env,
    message,
    ...(trouble ? { trouble: { kind: trouble.kind, at: trouble.at } } : {}),
    fmtTime: (at) => new Date(at).toLocaleString('de-CH', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }),
  }
  const techBlock = buildTechBlock(input)

  // Asking counts as asked, whether or not they send anything — otherwise the same crash comes
  // back on the next launch and the prompt becomes the nag we set out not to build.
  const finish = () => { markTroubleAsked(); onClose() }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildReport(input))
      toast(cp.copied, { icon: 'check' })
      finish()
    } catch {
      toast(cp.copyFailed, { icon: 'warn', tone: 'warn' })
    }
  }

  const mail = () => {
    location.href = mailtoUrl(appConfig.feedback.mailto, buildSubject(input, appName), buildReport(input))
    finish()
  }

  return (
    <Modal title={cp.title} onClose={finish} fit>
      <div className="fb-sheet">
        {trouble && <p className="fb-q">{cp.promptFor[trouble.kind]}</p>}
        <p className="fb-intro">{cp.intro}</p>

        <textarea
          className="fb-input"
          rows={5}
          value={message}
          placeholder={cp.placeholder}
          onChange={(e) => setMessage(e.target.value)}
          aria-label={cp.title}
          autoFocus
        />

        <details className="fb-tech">
          <summary>{cp.techTitle}</summary>
          <pre className="fb-tech-block">{techBlock}</pre>
          <p className="fb-tech-note">{cp.techNote}</p>
        </details>

        <p className="fb-privacy"><Icon id="info" /> {cp.privacy}</p>

        <div className="fb-actions">
          <button type="button" className="ip-btn" onClick={finish}>{cp.close}</button>
          <button type="button" className="ip-btn" onClick={() => void copy()}>
            <Icon id="copy" /> {cp.copy}
          </button>
          <button type="button" className="ip-btn primary" onClick={mail}>
            <Icon id="mail" /> {cp.mail}
          </button>
        </div>
      </div>
    </Modal>
  )
}
