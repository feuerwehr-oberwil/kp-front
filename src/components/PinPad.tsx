import { useEffect, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/** Digits in a PIN — mirrors the backend's `settings.pin_length`. */
export const PIN_LENGTH = 6

/** Colour of the line above the keys. `error` also shakes the dots. */
export type PinTone = 'error' | 'ok' | 'hint'

export interface PinPadProps {
  /** The digits entered so far (controlled — the owner decides what happens when it fills). */
  value: string
  onChange: (next: string) => void
  /** Fired when the last digit lands, and on Enter with a full PIN. Login submits here; the
   *  admin PIN sheet uses it to move to the confirmation step. */
  onComplete?: (pin: string) => void
  /** Keys and the physical keyboard go inert (busy, or the login cooldown lock). */
  disabled?: boolean
  /** One short line above the keys — the error, or what to do next. */
  message?: string
  tone?: PinTone
  /** The identity row above the dots: a back button on the login screen, the member whose
   *  PIN is being changed in the admin sheet. */
  header?: ReactNode
  length?: number
}

/**
 * The 6-digit pad — ONE implementation behind both the login gate and the admin PIN sheet.
 *
 * Built for gloved 3am taps: 76px round keys, dot progress, a physical keyboard that mirrors
 * the pad (digits append, Backspace deletes, Enter completes). It is deliberately dumb about
 * what a full PIN *means*: the login screen submits it, the admin sheet asks for it twice.
 * Painted with the `.pin-*` classes in src/styles/12-login.css.
 */
export function PinPad({
  value, onChange, onComplete, disabled = false, message, tone = 'error', header, length = PIN_LENGTH,
}: PinPadProps) {
  const press = (digit: string) => {
    if (disabled || value.length >= length) return
    const next = value + digit
    onChange(next)
    if (next.length === length) onComplete?.(next)
  }
  const backspace = () => { if (!disabled) onChange(value.slice(0, -1)) }

  // Physical keyboard: digits append, Backspace deletes, Enter completes a full PIN.
  // Mirrors the on-screen pad; inert while `disabled`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key) }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); backspace() }
      else if (e.key === 'Enter') { e.preventDefault(); if (value.length === length) onComplete?.(value) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, disabled, length]) // eslint-disable-line react-hooks/exhaustive-deps

  const keys: (string | 'back')[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back']

  return (
    <div className="pinpad">
      {header}

      <div className={`pin-dots ${tone === 'error' && message ? 'err' : ''}`}>
        {Array.from({ length }).map((_, i) => (
          <span key={i} className={`pin-dot ${i < value.length ? 'on' : ''}`} />
        ))}
      </div>

      {/* nbsp, not a plain space: an empty line still has to hold its row open */}
      <div className={`pin-msg ${tone}`} role="status">{message ?? ' '}</div>

      <div className="pin-grid">
        {keys.map((k, i) => {
          if (k === '') return <span key={i} className="pin-key-spacer" />
          if (k === 'back') {
            return (
              <button
                key={i}
                type="button"
                className="pin-key pin-key-fn"
                onClick={backspace}
                disabled={disabled || value.length === 0}
                aria-label={appConfig.copy.login.clearDigit}
              >
                <Icon id="close" />
              </button>
            )
          }
          return (
            <button key={i} type="button" className="pin-key" onClick={() => press(k)} disabled={disabled}>{k}</button>
          )
        })}
      </div>
    </div>
  )
}
