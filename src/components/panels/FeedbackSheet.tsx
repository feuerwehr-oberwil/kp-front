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
import { clearDraft, MAX_MESSAGE, readDraft, writeDraft } from '../../lib/feedbackDraft'
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
  // Restored, not empty: the sheet is dismissable by Esc and by a backdrop tap, and what was
  // typed must survive both — see lib/feedbackDraft.
  const [message, setMessage] = useState(readDraft)
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
  // back on the next launch and the prompt becomes the nag we set out not to build. The DRAFT
  // deliberately does not follow that rule: the cooldown is about how often we ask, the draft
  // is about not destroying someone's words, and only one of those should survive a stray tap.
  const finish = () => { markTroubleAsked(); onClose() }

  /** Exit after the text has actually gone somewhere — then, and only then, it stops being a draft. */
  const finishSent = () => { clearDraft(); finish() }

  const onMessage = (text: string) => { setMessage(text); writeDraft(text) }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildReport(input))
      toast(cp.copied, { icon: 'check' })
      finishSent()
    } catch {
      toast(cp.copyFailed, { icon: 'warn', tone: 'warn' })
    }
  }

  const mail = () => {
    location.href = mailtoUrl(appConfig.feedback.mailto, buildSubject(input, appName), buildReport(input))
    finishSent()
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
      // told about doesn't come back on the next launch. The draft goes too: it has left.
      markTroubleAsked()
      clearDraft()
      return
    }
    // Both failure modes leave the sheet open on purpose: the operator has typed something,
    // and the fallbacks (copy / mail) are right there and need no server.
    setState(outcome.reason === 'disabled' ? 'disabled' : 'failed')
  }

  // The sheet does not know whether the deployment has outbound enabled until it tries, so
  // the button is always offered and a 503 turns into an explanation rather than an error.
  const sendFailed = state === 'failed' || state === 'disabled'

  // An empty report with no trouble behind it is a blank row in someone's issue tracker. With
  // a trouble it still says «ja, das ist mir passiert», which is worth having. Copy and mail
  // stay open either way — a bare technical block in a mailbox is self-evidently ignorable,
  // and one of them is the only route left on a deployment with outbound switched off.
  const canSend = message.trim().length > 0 || !!trouble

  if (state === 'sent') {
    return (
      <Modal title={cp.title} onClose={finish} fit>
        <div className="fb-sheet">
          <p className="fb-q"><Icon id="check" /> {cp.sentTitle}</p>
          <p className="fb-intro">{cp.sentBody}</p>
          {/* Collapsed here, unlike before the send: this screen answers «ist es angekommen»,
              and opening with a wall of JSON buries that answer under something the operator
              has already had their chance to read. It stays one tap away for whoever wants it. */}
          <details className="fb-tech">
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

        {/* No autoFocus: on a tablet it raises the on-screen keyboard over the very block we
            are asking the operator to read before deciding. They tap the field when they are
            ready to write. */}
        <textarea
          className="fb-input"
          rows={5}
          value={message}
          maxLength={MAX_MESSAGE}
          placeholder={cp.placeholder}
          onChange={(e) => onMessage(e.target.value)}
          aria-label={cp.title}
        />
        {/* Only near the ceiling, and digits only — no copy key needed, correct in every
            locale. Without it the cap is invisible until the server rejects the report. */}
        {message.length > MAX_MESSAGE * 0.9 && (
          <p className="fb-count">{message.length}/{MAX_MESSAGE}</p>
        )}

        {/* Open by default. «Das wird mitgeschickt» is only credible if it is readable at the
            moment the decision is made — behind a tap it is a claim, in front of the buttons
            it is a fact. */}
        <details className="fb-tech" open>
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

        {/* The two routes that need no server, kept quiet and on their own line. Four buttons
            of equal weight in one wrapping row is four decisions, and three of them are about
            TRANSPORT — something the operator has no opinion about and shouldn't need one on.
            They are still one tap away, and they become the loud route the moment sending has
            demonstrably failed. */}
        <div className="fb-alt">
          <button type="button" className="fb-alt-btn" onClick={() => void copy()}>
            <Icon id="copy" /> {cp.copy}
          </button>
          {!sendFailed && (
            <button type="button" className="fb-alt-btn" onClick={mail}>
              <Icon id="mail" /> {cp.mail}
            </button>
          )}
        </div>

        <div className="fb-actions">
          <button type="button" className="ip-btn" onClick={finish}>{cp.close}</button>
          {sendFailed ? (
            /* Once sending has demonstrably failed, mail is promoted to the primary route —
               the same escalation ErrorBoundary makes when reloading didn't work. */
            <button type="button" className="ip-btn primary" onClick={mail}>
              <Icon id="mail" /> {cp.mail}
            </button>
          ) : (
            <button
              type="button"
              className="ip-btn primary"
              onClick={() => void send()}
              disabled={state === 'sending' || !canSend}
            >
              <Icon id="upload" /> {state === 'sending' ? cp.sending : cp.send}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
