import { useState } from 'react'
import { apiPost, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate, initials } from '../lib/format'
import { Sheet } from '../lib/overlays'
import { PinPad, PIN_LENGTH } from '../components/PinPad'

const NEUTRAL_COLOR = '#6c7686' // --ink-faint, same fallback as the login roster tiles

/** PINs that are not secrets, whatever the deployment — mirrors `TRIVIAL_PINS` in
 *  backend/app/auth/security.py.
 *
 *  A HINT, not the guard: `POST /api/auth/users/{id}/pin` now refuses the same six itself
 *  (`auth/router._hash_pin_or_400`), and the server is the authority. The copy lives here so the
 *  refusal appears as the sixth digit lands — before «Weiter», before a round trip — instead of
 *  letting somebody confirm a PIN twice and only then be told no. Keep it in sync; if the two
 *  ever disagree, the server's answer is the one that counts. */
const TRIVIAL_PINS = new Set(['000000', '111111', '123456', '654321', '999999', '012345'])

const isComplete = (pin: string) => pin.length === PIN_LENGTH && /^\d+$/.test(pin)

export interface PinSheetUser {
  id: string
  display_name: string
  color: string | null
}

/**
 * Setting a member's PIN — the product's own pinpad in a Sheet.
 *
 * Replaces `window.prompt()`, which an installed iOS PWA may suppress without a trace: the first
 * thing the setup docs ask an operator to do was a button that could silently do nothing. The pad
 * is the SAME component the crew taps at every login (src/components/PinPad.tsx), so nothing new
 * has to be learned, and the PIN is typed twice because a typo here locks somebody out of a
 * fireground tablet on a Sunday night.
 */
export function PinSheet({ user, onClose, onSaved }: {
  user: PinSheetUser
  onClose: () => void
  onSaved: () => void
}) {
  const C = appConfig.copy.admin.members
  const Cc = appConfig.copy.admin.common2
  const [step, setStep] = useState<'set' | 'confirm'>('set')
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const trivial = isComplete(first) && TRIVIAL_PINS.has(first)
  const matches = step === 'confirm' && isComplete(second) && second === first
  const canContinue = isComplete(first) && !trivial

  const identity = (
    <div className="pin-backuser adm-pin-who">
      <span className="pin-avatar" style={{ background: user.color ?? NEUTRAL_COLOR }}>
        {initials(user.display_name)}
      </span>
      <span className="pin-username">{user.display_name}</span>
    </div>
  )

  const save = async () => {
    if (!matches || busy) return
    setBusy(true)
    setErr(null)
    try {
      await apiPost(`/api/auth/users/${user.id}/pin`, { pin: second })
      onSaved()
    } catch (e) {
      // Every refusal this endpoint returns is German now (auth/router · _PIN_TOO_SIMPLE,
      // _PIN_WRONG_LENGTH), so it is shown as it arrives — nothing left to translate here.
      setErr(e instanceof ApiError ? e.detail : Cc.unknownError)
      setSecond('')
      setBusy(false)
    }
  }

  // step 1 — enter, step 2 — confirm. Each step owns its own title, message and actions.
  const setting = step === 'set'
  const message = err
    ?? (setting
      ? (trivial ? C.pinTrivial : fillTemplate(C.pinEnterHint, { n: PIN_LENGTH }))
      : (matches ? C.pinMatch : C.pinConfirmHint))
  const tone = err || trivial ? 'error' : matches ? 'ok' : 'hint'

  return (
    <Sheet
      open
      onClose={onClose}
      title={setting ? C.pinSheetTitle : C.pinConfirmTitle}
      fit
      modal
      sheetClassName="adm-pin-sheet"
      footer={setting ? (
        <>
          <button type="button" className="ip-btn ghost" onClick={onClose}>{Cc.cancel}</button>
          <button
            type="button"
            className="ip-btn primary"
            disabled={!canContinue}
            onClick={() => { setErr(null); setStep('confirm') }}
          >
            {C.pinNext}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="ip-btn ghost"
            onClick={() => { setSecond(''); setErr(null); setStep('set') }}
            disabled={busy}
          >
            {C.pinBack}
          </button>
          <button type="button" className="ip-btn primary" disabled={!matches || busy} onClick={() => void save()}>
            {busy ? Cc.saving : C.pinSave}
          </button>
        </>
      )}
    >
      <p className="adm-pin-sub">{setting ? C.pinSheetSub : C.pinConfirmSub}</p>
      <PinPad
        value={setting ? first : second}
        onChange={(next) => { setErr(null); if (setting) setFirst(next); else setSecond(next) }}
        onComplete={(full) => {
          if (setting) return // the explicit «Weiter» advances — no silent jump on the 6th digit
          if (full !== first) { setErr(C.pinMismatch); setSecond('') }
        }}
        disabled={busy}
        message={message}
        tone={tone}
        header={identity}
      />
    </Sheet>
  )
}
