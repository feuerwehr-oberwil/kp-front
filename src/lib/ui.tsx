import { Fragment, useEffect, useState } from 'react'
import { Icon, PrinterFeedIcon } from './icons'
import { appConfig } from '../config/appConfig'
import { ConfirmCard } from './overlays/ConfirmCard'
import { Overlay } from './overlays'

// Lightweight app-wide toast + confirm host. Replaces native alert()/confirm()
// so transient feedback and destructive confirmations stay inside the glass
// design language. Imperative API (toast / confirmDialog) backed by a tiny
// module store; mount <Overlays/> once at the app root.

type Tone = 'default' | 'warn' | 'success'
interface ToastAction { label: string; onClick: () => void }
/** One stage of a multi-step toast (the live print job). `icon` omitted = an unreached step,
 * drawn as a dim pip; `printer` is the animated «paper coming out» glyph. */
export interface ToastStep {
  label: string
  state: 'done' | 'now' | 'future' | 'fail'
  icon?: 'check' | 'warn' | 'printer'
}
interface Toast { id: number; text: string; icon?: string; tone: Tone; action?: ToastAction; steps?: ToastStep[] }
interface ConfirmReq {
  id: number
  title?: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  resolve: (v: boolean) => void
}

/** The picture currently being looked at full-size (see openPhoto). */
interface PhotoReq { url: string; filename: string; caption?: string }

let toasts: Toast[] = []
let confirmReq: ConfirmReq | null = null
let photoReq: PhotoReq | null = null
const listeners = new Set<() => void>()
let seq = 1
const emit = () => listeners.forEach((l) => l())

// Pending auto-dismiss timers, keyed by toast id, so updateToast can reset a toast's clock
// and dismissToast can cancel it (a live status toast is sticky until it reaches done/failed).
const timers = new Map<number, ReturnType<typeof setTimeout>>()
function scheduleDismiss(id: number, ms: number) {
  const prev = timers.get(id)
  if (prev) clearTimeout(prev)
  timers.set(id, setTimeout(() => { dismissToast(id) }, ms))
}

export function dismissToast(id: number) {
  const prev = timers.get(id)
  if (prev) { clearTimeout(prev); timers.delete(id) }
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function toast(text: string, opts?: { icon?: string; tone?: Tone; duration?: number; action?: ToastAction; sticky?: boolean; steps?: ToastStep[] }): number {
  const id = seq++
  toasts = [...toasts, { id, text, icon: opts?.icon, tone: opts?.tone ?? 'default', action: opts?.action, steps: opts?.steps }]
  emit()
  // sticky toasts stay until updateToast/dismissToast decides (live status). Otherwise an
  // action (e.g. confirm-with-undo) needs time to be seen and tapped.
  if (!opts?.sticky) scheduleDismiss(id, opts?.duration ?? (opts?.action ? 6000 : 2800))
  return id
}

/** Patch a live toast in place (text/icon/tone/action). Pass `duration` to auto-dismiss it
 * (e.g. once the job reaches done/failed); omit to keep it sticky. Unknown id = no-op. */
export function updateToast(id: number, text: string, opts?: { icon?: string; tone?: Tone; duration?: number; action?: ToastAction | null; steps?: ToastStep[] | null }) {
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.map((t) => t.id === id
    ? { ...t, text, icon: opts?.icon, tone: opts?.tone ?? 'default', action: opts?.action ?? undefined, steps: opts?.steps ?? undefined }
    : t)
  emit()
  if (opts?.duration) scheduleDismiss(id, opts.duration)
}

export function confirmDialog(opts: {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    // a fresh request supersedes any pending one (resolve the old as cancelled)
    confirmReq?.resolve(false)
    confirmReq = {
      id: seq++,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? appConfig.copy.confirm.ok,
      cancelLabel: opts.cancelLabel ?? appConfig.copy.confirm.cancel,
      danger: opts.danger,
      resolve,
    }
    emit()
  })
}

/**
 * Show one picture full-size, in the app.
 *
 * A photo used to open with `target="_blank"`. In a browser tab that is merely untidy; in the
 * INSTALLED app it leaves the app — iOS hands the picture to Safari and the operator has to find
 * their way back to a running Einsatz. So it opens here, over the surface, with the one thing the
 * new tab was actually good for: a download.
 *
 * Imperative like toast()/confirmDialog(), so a thumbnail anywhere can call it without every
 * surface in between having to carry a viewer prop.
 */
export function openPhoto(url: string, opts?: { filename?: string; caption?: string }) {
  photoReq = { url, filename: opts?.filename || 'foto.jpg', caption: opts?.caption }
  emit()
}

function useForceUpdate() {
  const [, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
}

/** The step chain of a live job: done steps keep their tick and step back, the running one
 * carries the label, the unreached ones stay visible as pips so «what still has to happen» is
 * readable at a glance. Below 520px the labels of everything but the running step drop away
 * (app.css) — the chain then still fits one line on a phone.
 * `text` is the plain sentence: it stays as the screen-reader announcement, because reading a
 * chain of three stage names out loud says nothing about which one is current. */
function ToastSteps({ steps, text }: { steps: ToastStep[]; text: string }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span className="toast-steps" aria-hidden>
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 && <span className="toast-chev"><Icon id="chevron" /></span>}
            <span className={`toast-step ${s.state}`}>
              {s.icon === 'printer' ? <PrinterFeedIcon /> : s.icon ? <Icon id={s.icon} /> : <span className="toast-pip" />}
              <span className="toast-step-label">{s.label}</span>
            </span>
          </Fragment>
        ))}
      </span>
    </>
  )
}

export function Overlays() {
  useForceUpdate()
  const req = confirmReq
  const photo = photoReq
  const closePhoto = () => { photoReq = null; emit() }

  const close = (v: boolean) => {
    const r = confirmReq
    confirmReq = null
    emit()
    r?.resolve(v)
  }

  return (
    <>
      <div className="toaster" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role="status">
            {t.steps ? <ToastSteps steps={t.steps} text={t.text} /> : (
              <>
                {t.icon && <Icon id={t.icon} />}
                <span>{t.text}</span>
              </>
            )}
            {t.action && (
              <button
                className="btn toast-action"
                onClick={() => {
                  dismissToast(t.id)
                  t.action!.onClick()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      <ConfirmCard
        open={!!req}
        title={req?.title}
        message={req?.message ?? ''}
        confirmLabel={req?.confirmLabel ?? ''}
        cancelLabel={req?.cancelLabel ?? ''}
        danger={req?.danger}
        onResolve={close}
      />

      {/* full-size picture — see openPhoto */}
      {photo && (
        <Overlay open onClose={closePhoto} className="photo-view" ariaLabel={photo.caption || appConfig.copy.photoViewer.title}>
          <div className="photo-view-head">
            <span className="photo-view-cap">{photo.caption || appConfig.copy.photoViewer.title}</span>
            {/* same-origin /api/media URL, so `download` really downloads instead of navigating */}
            <a className="btn" href={photo.url} download={photo.filename}>
              <Icon id="download" />{appConfig.copy.photoViewer.download}
            </a>
            <button className="ctx-x" onClick={closePhoto} aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog}>
              <Icon id="close" />
            </button>
          </div>
          <img className="photo-view-img" src={photo.url} alt={photo.caption ?? ''} />
        </Overlay>
      )}
    </>
  )
}
