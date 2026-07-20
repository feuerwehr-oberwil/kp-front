import { useEffect, useState } from 'react'
import { Icon } from './icons'
import { appConfig } from '../config/appConfig'
import { ConfirmCard } from './overlays/ConfirmCard'

// Lightweight app-wide toast + confirm host. Replaces native alert()/confirm()
// so transient feedback and destructive confirmations stay inside the glass
// design language. Imperative API (toast / confirmDialog) backed by a tiny
// module store; mount <Overlays/> once at the app root.

type Tone = 'default' | 'warn' | 'success'
interface ToastAction { label: string; onClick: () => void }
interface Toast { id: number; text: string; icon?: string; tone: Tone; action?: ToastAction }
interface ConfirmReq {
  id: number
  title?: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  resolve: (v: boolean) => void
}

let toasts: Toast[] = []
let confirmReq: ConfirmReq | null = null
const listeners = new Set<() => void>()
let seq = 1
const emit = () => listeners.forEach((l) => l())

export function toast(text: string, opts?: { icon?: string; tone?: Tone; duration?: number; action?: ToastAction }) {
  const id = seq++
  toasts = [...toasts, { id, text, icon: opts?.icon, tone: opts?.tone ?? 'default', action: opts?.action }]
  emit()
  // an action (e.g. confirm-with-undo) needs time to be seen and tapped
  const duration = opts?.duration ?? (opts?.action ? 6000 : 2800)
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit() }, duration)
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

function useForceUpdate() {
  const [, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
}

export function Overlays() {
  useForceUpdate()
  const req = confirmReq

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
            {t.icon && <Icon id={t.icon} />}
            <span>{t.text}</span>
            {t.action && (
              <button
                className="btn toast-action"
                onClick={() => {
                  toasts = toasts.filter((x) => x.id !== t.id)
                  emit()
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
    </>
  )
}
