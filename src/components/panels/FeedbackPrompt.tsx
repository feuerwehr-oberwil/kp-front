import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { troubleLabel } from '../../lib/feedbackReport'
import { markTroubleAsked, type TroubleEvent } from '../../lib/trouble'

/** The «kurz gefragt» card on the launcher, shown when something went wrong recently.
 *
 *  It renders on the launcher ONLY — never over an open incident. That placement is the whole
 *  design: at 3am with a Trupp inside, the answer to any question is «nein», and a prompt is
 *  exactly the kind of thing the operator must not have to deal with. Asked on a Tuesday evening
 *  instead, the same person writes two useful sentences.
 *
 *  Dismissing counts as asked (the cooldown starts either way), so this can never nag. */
export function FeedbackPrompt({ trouble, onOpen, onDismiss }: {
  trouble: TroubleEvent
  onOpen: () => void
  onDismiss: () => void
}) {
  const cp = appConfig.copy.feedback
  const dismiss = () => { markTroubleAsked(); onDismiss() }
  // A region, not role="status": a live region re-announces its whole subtree on change, and this
  // one contains two buttons. The card is not news arriving mid-task either — it is part of the
  // launcher the operator is already looking at.
  return (
    <div className="fb-prompt" role="region" aria-label={cp.promptTitle}>
      <div className="fb-prompt-head">
        <Icon id="info" />
        <span className="fb-prompt-kicker">{cp.promptTitle}</span>
        <span className="fb-prompt-what">{troubleLabel(trouble.kind)}</span>
      </div>
      <p className="fb-prompt-q">{cp.promptFor[trouble.kind]}</p>
      <div className="fb-prompt-actions">
        <button type="button" className="ip-btn" onClick={dismiss}>{cp.promptDismiss}</button>
        <button type="button" className="ip-btn primary" onClick={onOpen}>{cp.promptOpen}</button>
      </div>
    </div>
  )
}
