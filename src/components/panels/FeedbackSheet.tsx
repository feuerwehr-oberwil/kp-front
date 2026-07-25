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
import { submitReport } from '../../lib/feedbackSubmit'
import { Modal } from './_shared'

/** Rückmeldung composer. Opened either from Einstellungen (no `trouble`) or from the launcher
 *  prompt after something went wrong (`trouble` set, so the question can be specific).
 *
 *  Nothing is ever sent automatically. The app writes the text, shows it in full, and the
 *  operator picks one of three exits: copy it, mail it, or send it directly. The direct route
 *  is not an exception to that rule — pressing the button is the same act of consent as
 *  pressing send in a mail client, and it exists because half the tablets in a Magazin have no
 *  mail client configured. The technical block stays rendered verbatim above the buttons for
 *  exactly the reason it always was: «das wird mitgeschickt» is only credible if you can read
 *  it before you decide. After a direct send we additionally show what the SERVER says it
 *  queued — a preview written by the sender is a promise, one echoed by the receiver is a
 *  check. */
export function FeedbackSheet({ trouble, onClose }: {
  trouble?: TroubleEvent
  onClose: () => void
}) {
  const cp = appConfig.copy.feedback
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'disabled' | 'failed'>('idle')
  const [echoed, setEchoed] = useState<string | null>(null)

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

  const send = async () => {
    setState('sending')
    const outcome = await submitReport({
      message,
      locale: appConfig.locale,
      viewport: env.viewport,
      online: env.online,
      ...(trouble ? { trouble } : {}),
    })
    if (outcome.ok) {
      setEchoed(JSON.stringify(outcome.sent, null, 2))
      setState('sent')
      // Counts as asked either way — same rule as copy/mail, so a crash we've already been
      // told about doesn't come back on the next launch.
      markTroubleAsked()
      return
    }
    // Both failure modes leave the sheet open on purpose: the operator has typed something,
    // and the fallbacks (copy / mail) are right there and need no server.
    setState(outcome.reason === 'disabled' ? 'disabled' : 'failed')
  }

  // The sheet does not know whether the deployment has outbound enabled until it tries, so
  // the button is always offered and a 503 turns into an explanation rather than an error.
  const sendFailed = state === 'failed' || state === 'disabled'

  if (state === 'sent') {
    return (
      <Modal title={cp.title} onClose={finish} fit>
        <div className="fb-sheet">
          <p className="fb-q"><Icon id="check" /> {cp.sentTitle}</p>
          <p className="fb-intro">{cp.sentBody}</p>
          <details className="fb-tech" open>
            <summary>{cp.sentWhat}</summary>
            <pre className="fb-tech-block">{echoed}</pre>
            <p className="fb-tech-note">{cp.sentEcho}</p>
          </details>
          <div className="fb-actions">
            <button type="button" className="ip-btn primary" onClick={finish}>{cp.close}</button>
          </div>
        </div>
      </Modal>
    )
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
        {sendFailed && (
          <p className="fb-privacy fb-warn" role="status">
            <Icon id="warn" /> {state === 'disabled' ? cp.sendDisabled : cp.sendFailed}
          </p>
        )}

        <div className="fb-actions">
          <button type="button" className="ip-btn" onClick={finish}>{cp.close}</button>
          <button type="button" className="ip-btn" onClick={() => void copy()}>
            <Icon id="copy" /> {cp.copy}
          </button>
          {/* Once sending has demonstrably failed, mail becomes the primary route again —
              the same escalation ErrorBoundary makes when reloading didn't work. */}
          <button type="button" className={`ip-btn${sendFailed ? ' primary' : ''}`} onClick={mail}>
            <Icon id="mail" /> {cp.mail}
          </button>
          {!sendFailed && (
            <button
              type="button"
              className="ip-btn primary"
              onClick={() => void send()}
              disabled={state === 'sending'}
            >
              <Icon id="upload" /> {state === 'sending' ? cp.sending : cp.send}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
