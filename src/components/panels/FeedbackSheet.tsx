import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { buildLabel } from '../../lib/buildInfo'
import { getDeploymentConfig } from '../../lib/deploymentConfig'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import {
  buildReport, buildSubject, buildTechBlock, mailtoUrl, readEnv, type ReportInput,
} from '../../lib/feedbackReport'
import { markTroubleAsked, type TroubleEvent } from '../../lib/trouble'
import { PHOTO_LIMIT, submitReport } from '../../lib/feedbackSubmit'
import { prepareFeedbackPhoto } from '../../lib/imagePrep'
import { clearDraft, MAX_MESSAGE, readDraft, writeDraft } from '../../lib/feedbackDraft'
import { Modal } from './_shared'

/** An attached photo, as the sheet holds it: the downscaled blob that will travel, plus an
 *  object URL for the thumbnail. In memory only — unlike the typed text, a picture has no
 *  business surviving a dismissed sheet in localStorage. */
interface AttachedPhoto { id: string; blob: Blob; url: string }

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
 *  check.
 *
 *  A photo may be attached, and it is the one part of the payload that no scrubber can read.
 *  That is why it is handled the way it is here: the operator picks the file (the app never
 *  captures a screen), the picture is shown at thumbnail size right under the block it belongs
 *  to — «das wird mitgeschickt» has to stay literally true once there is a picture in it — and
 *  it rides the direct route only, because the clipboard and a mailto: URL hold text. */
export function FeedbackSheet({ trouble, onClose }: {
  trouble?: TroubleEvent
  onClose: (reason: 'cancel' | 'complete') => void
}) {
  const cp = appConfig.copy.feedback
  // Restored, not empty: the sheet is dismissable by Esc and by a backdrop tap, and what was
  // typed must survive both — see lib/feedbackDraft.
  const [message, setMessage] = useState(readDraft)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'disabled' | 'failed'>('idle')
  const [echoed, setEchoed] = useState<string | null>(null)
  const [photos, setPhotos] = useState<AttachedPhoto[]>([])

  // Object URLs outlive the render that made them, so they are revoked from a ref rather than
  // from the state a cleanup would close over stale.
  const urls = useRef<string[]>([])
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)) }, [])

  const dropPhotos = () => {
    urls.current.forEach((u) => URL.revokeObjectURL(u))
    urls.current = []
    setPhotos([])
  }

  const addPhotos = async (files: File[]) => {
    for (const file of files.slice(0, PHOTO_LIMIT)) {
      // Downscaled here, in the browser, before the file has been anywhere: a 12-megapixel
      // tablet photo is not a telemetry row, and the re-encode also drops the EXIF a phone
      // stamps its GPS position into. `null` = it could not be made to fit, and saying so now
      // is the whole point — the alternative is a send that reports success and a photo the
      // server quietly refuses.
      const blob = await prepareFeedbackPhoto(file)
      if (!blob) { toast(cp.photoTooBig, { icon: 'warn', tone: 'warn' }); continue }
      const url = URL.createObjectURL(blob)
      urls.current.push(url)
      setPhotos((prev) => (prev.length >= PHOTO_LIMIT
        ? prev
        : [...prev, { id: `fp${Date.now()}-${prev.length}`, blob, url }]))
    }
  }

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone) {
        URL.revokeObjectURL(gone.url)
        urls.current = urls.current.filter((u) => u !== gone.url)
      }
      return prev.filter((p) => p.id !== id)
    })
  }

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
  const finish = (reason: 'cancel' | 'complete') => { markTroubleAsked(); onClose(reason) }

  /** Exit after the text has actually gone somewhere — then, and only then, it stops being a
   *  draft. The photos go with it: they were attached to this report, not to the next one. */
  const finishSent = () => { clearDraft(); dropPhotos(); finish('complete') }

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
      ...(photos.length ? { photos: photos.map((p) => p.blob) } : {}),
    })
    if (outcome.ok) {
      setEchoed(JSON.stringify(outcome.sent, null, 2))
      setState('sent')
      // Counts as asked either way — same rule as copy/mail, so a crash we've already been
      // told about doesn't come back on the next launch. The draft goes too: it has left.
      markTroubleAsked()
      clearDraft()
      dropPhotos()
      return
    }
    // Both failure modes leave the sheet open on purpose: the operator has typed something,
    // and the fallbacks (copy / mail) are right there and need no server.
    // 'disabled' additionally takes the attach control away below — offering to attach a photo
    // to a route that cannot run is worse than not offering it.
    setState(outcome.reason === 'disabled' ? 'disabled' : 'failed')
  }

  // The sheet does not know whether the deployment has outbound enabled until it tries, so
  // the button is always offered and a 503 turns into an explanation rather than an error.
  const sendFailed = state === 'failed' || state === 'disabled'

  // Attaching is offered until the server has said the direct route does not exist here. Not
  // on 'failed' — that is offline, which is the normal state of a tablet at an Einsatz and the
  // report will go later. Photos already attached stay visible either way: the note under
  // Kopieren/E-Mail is what explains that they can only travel the direct way, and quietly
  // deleting something the operator chose would be the worse answer.
  const canAttach = state !== 'disabled'

  // An empty report with no trouble behind it is a blank row in someone's issue tracker. With
  // a trouble it still says «ja, das ist mir passiert», which is worth having. Copy and mail
  // stay open either way — a bare technical block in a mailbox is self-evidently ignorable,
  // and one of them is the only route left on a deployment with outbound switched off.
  const canSend = message.trim().length > 0 || !!trouble

  if (state === 'sent') {
    return (
      <Modal title={cp.title} onClose={() => finish('complete')} fit>
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
            <button type="button" className="ip-btn primary" onClick={() => finish('complete')}>{cp.close}</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={cp.title} onClose={() => finish('cancel')} fit>
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

        {/* Directly under the technical block, not behind it: a picture is part of «das wird
            mitgeschickt», and the only part of it the app itself cannot read. So it is shown
            the same way the JSON is — in front of the buttons, at a size you can recognise. */}
        {(canAttach || photos.length > 0) && (
          <div className="fb-photos">
            {photos.map((p) => (
              <figure key={p.id} className="fb-photo">
                <img src={p.url} alt={cp.photoAlt} />
                <button
                  type="button"
                  className="fb-photo-x"
                  aria-label={cp.photoRemove}
                  title={cp.photoRemove}
                  onClick={() => removePhoto(p.id)}
                >
                  <Icon id="close" />
                </button>
              </figure>
            ))}
            {canAttach && photos.length < PHOTO_LIMIT && (
              <label className="fb-photo-add">
                <Icon id="photo" />
                <span>{cp.photoAdd}</span>
                {/* accept="image/*" and no `capture`: on a tablet this offers the camera AND
                    the library, and which of the two is right is the operator's call — the
                    photo they want is as often already on the device as still to be taken. */}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])]
                    e.target.value = '' // so re-picking the same file fires onChange again
                    if (files.length) void addPhotos(files)
                  }}
                />
              </label>
            )}
            {photos.length === 0 && <span className="fb-photo-hint">{cp.photoHint}</span>}
          </div>
        )}

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
        {/* A note, not a disabled button. The clipboard and a mailto: URL genuinely cannot
            carry a file, but the TEXT is still worth copying — and on a deployment with
            outbound switched off it is the only way out at all. Saying so beats taking the
            route away and leaving the operator to work out why. */}
        {photos.length > 0 && (
          <p className="fb-photo-note" role="status">{cp.photoOnlyDirect}</p>
        )}

        <div className="fb-actions">
          <button type="button" className="ip-btn" onClick={() => finish('cancel')}>{cp.close}</button>
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
