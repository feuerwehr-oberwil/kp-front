import { useEffect, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/** PIN length policy — mirrors the backend's `settings.pin_min_length` / `pin_max_length`.
 *  The pad deliberately shows NO empty slots: how long a PIN is stays that PIN's secret. */
export const PIN_MIN_LENGTH = 6
export const PIN_MAX_LENGTH = 12

/** A PIN the policy accepts: 6–12 digits. Shared by every surface that gates on one. */
export const isValidPin = (pin: string) => pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH && /^\d+$/.test(pin)

/** Colour of the line above the keys. `error` also shakes the dots. */
export type PinTone = 'error' | 'ok' | 'hint'

export interface PinPadProps {
  /** The digits entered so far (controlled — the owner decides what a submit means). */
  value: string
  onChange: (next: string) => void
  /** Fired by the ✓ key and by Enter, only with a policy-valid PIN. The ✓ key renders only
   *  when this is given — the admin PIN sheet drives its steps from the Sheet footer instead. */
  onSubmit?: (pin: string) => void
  /** Keys and the physical keyboard go inert (busy, or the login cooldown lock). */
  disabled?: boolean
  /** One short line above the keys — the error, or what to do next. */
  message?: string
  tone?: PinTone
  /** The identity row above the dots: a back button on the login screen, the member whose
   *  PIN is being changed in the admin sheet. */
  header?: ReactNode
}

/**
 * The PIN pad — ONE implementation behind both the login gate and the admin PIN sheet.
 *
 * Built for gloved 3am taps: 76px round keys, dot progress, a physical keyboard that mirrors
 * the pad (digits append, Backspace deletes, Enter submits). Since 06.09. a PIN is 6–12 digits
 * and the pad never announces how many: one dot per typed digit, no empty slots, and nothing
 * happens until the ✓ (or Enter) confirms — so watching the screen teaches a bystander nothing
 * about a PIN's length. Painted with the `.pin-*` classes in src/styles/12-login.css.
 */
export function PinPad({
  value, onChange, onSubmit, disabled = false, message, tone = 'error', header,
}: PinPadProps) {
  const press = (digit: string) => {
    if (disabled || value.length >= PIN_MAX_LENGTH) return
    onChange(value + digit)
  }
  const backspace = () => { if (!disabled) onChange(value.slice(0, -1)) }
  const submit = () => { if (!disabled && isValidPin(value)) onSubmit?.(value) }

  // Physical keyboard: digits append, Backspace deletes, Enter submits a valid PIN.
  // Mirrors the on-screen pad; inert while `disabled`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key) }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); backspace() }
      else if (e.key === 'Enter') { e.preventDefault(); submit() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, disabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // ✓ bottom-left (only with an onSubmit), ⌫ stays bottom-right where every login has tapped it.
  const keys: (string | 'back' | 'ok' | '')[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', onSubmit ? 'ok' : '', '0', 'back']

  return (
    <div className="pinpad">
      {header}

      <div className={`pin-dots ${tone === 'error' && message ? 'err' : ''}`}>
        {/* one dot per typed digit — NO empty slots: the pad must not say how long the PIN is */}
        {Array.from({ length: value.length }).map((_, i) => (
          <span key={i} className="pin-dot on" />
        ))}
      </div>

      {/* nbsp, not a plain space: an empty line still has to hold its row open */}
      <div className={`pin-msg ${tone}`} role="status">{message ?? ' '}</div>

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
          if (k === 'ok') {
            return (
              <button
                key={i}
                type="button"
                className="pin-key pin-key-ok"
                onClick={submit}
                disabled={disabled || !isValidPin(value)}
                aria-label={appConfig.copy.login.submitPin}
                title={appConfig.copy.login.submitPin}
              >
                <Icon id="check" />
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
