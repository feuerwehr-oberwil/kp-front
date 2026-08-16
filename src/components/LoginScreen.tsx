import { useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { useAuth, type RosterEntry } from '../lib/auth'
import { Brand } from './Brand'
import { demoNote } from '../lib/deploymentConfig'
import { IconSprite, Icon } from '../lib/icons'
import { fillTemplate, initials, roleLabel } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { PinPad } from './PinPad'

const NEUTRAL_COLOR = '#6c7686' // --ink-faint, for roster tiles without an assigned colour

// Kiosk login gate. Built for fast, gloved 3am use on shared station/vehicle
// tablets: pick a face (no typed identity), then tap a 6-digit PIN. Matches the
// "Karte Minimal" dark tactical language.
export function LoginScreen() {
  const { login } = useAuth()
  const [roster, setRoster] = useState<RosterEntry[] | null>(null)
  // The whole error, not just its headline: what happened, what to do about it, and the raw
  // status for whoever ends up on the phone to the person running the server.
  const [rosterError, setRosterError] = useState<RosterError | null>(null)
  const [selected, setSelected] = useState<RosterEntry | null>(null)
  // Retry nonce: the roster fetch is the very first thing the operator depends on, and on a
  // flaky fireground link it can simply fail. Without a retry the login screen was a dead end —
  // an error line with nothing to tap, escapable only by knowing to kill the app.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setRosterError(null)
    setRoster(null)
    apiGet<RosterEntry[]>('/api/auth/roster')
      .then((r) => { if (alive) setRoster(r) })
      .catch((e: unknown) => {
        if (!alive) return
        setRosterError(e instanceof ApiError
          // status 0 is the offline path and has no HTTP code to quote — showing "Fehlercode 0"
          // would invent a server answer that never came.
          ? { detail: e.detail, hint: e.hint, code: e.status > 0 ? e.status : undefined }
          : { detail: appConfig.copy.login.connectionFailed })
      })
    return () => { alive = false }
  }, [attempt])

  return (
    <div className="login">
      <IconSprite />
      <div className="login-card">
        <Brand sub={selected ? appConfig.copy.login.pinEnter : appConfig.copy.login.subtitle} />

        {demoNote() && <p className="login-demo-note">{demoNote()}</p>}

        {selected
          ? <LoginPinPad user={selected} onLogin={login} onBack={() => setSelected(null)} />
          : <Roster roster={roster} error={rosterError} onPick={setSelected} onRetry={() => setAttempt((n) => n + 1)} />}
      </div>
    </div>
  )
}

/** A failed roster load, as much of it as we can put on screen. */
interface RosterError {
  detail: string
  hint?: string
  /** HTTP status, when there was one — absent for a network failure. */
  code?: number
}

function Roster({ roster, error, onPick, onRetry }: {
  roster: RosterEntry[] | null
  error: RosterError | null
  onPick: (r: RosterEntry) => void
  onRetry: () => void
}) {
  if (error) {
    return (
      <div className="login-state login-state-err">
        <div className="login-err-head">
          <Icon id="warn" />
          <span>{error.detail}</span>
        </div>
        {error.hint && <p className="login-err-hint">{error.hint}</p>}
        {error.code !== undefined && (
          <p className="login-err-code">{fillTemplate(appConfig.copy.errors.httpCode, { code: error.code })}</p>
        )}
        <button type="button" className="ip-btn" onClick={onRetry}>{appConfig.copy.login.retry}</button>
      </div>
    )
  }
  if (!roster) {
    return <div className="login-state">{appConfig.copy.login.loadingRoster}</div>
  }
  if (roster.length === 0) {
    return <div className="login-state">{appConfig.copy.login.noUsers}</div>
  }
  // A single registered user gets one prominent, centred tile (not a lonely cell in a
  // 2-up grid); more than one keeps the gloved-friendly grid.
  const solo = roster.length === 1
  return (
    <>
      <div className="login-hint">{appConfig.copy.login.whoAreYou}</div>
      <div className={`roster ${solo ? 'roster-solo' : ''}`}>
        {roster.map((r) => (
          <button key={r.id} className="roster-tile" onClick={() => onPick(r)}>
            <span className="roster-avatar" style={{ background: r.color ?? NEUTRAL_COLOR }}>
              {initials(r.display_name)}
            </span>
            <span className="roster-meta">
              <span className="roster-name">{r.display_name}</span>
              <span className={`roster-role ${r.role}`}>{roleLabel(r.role)}</span>
            </span>
            <span className="roster-go" aria-hidden><Icon id="chevron" /></span>
          </button>
        ))}
      </div>
    </>
  )
}

// The login gate's use of the shared pad (src/components/PinPad.tsx): auto-submit on the 6th
// digit, plus the 429 cooldown lock that only this caller has.
function LoginPinPad({ user, onLogin, onBack }: {
  user: RosterEntry
  onLogin: (userId: string, pin: string) => Promise<void>
  onBack: () => void
}) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // disabled until this monotonic timestamp (ms) — drives the 429 cooldown lock
  const [lockedUntil, setLockedUntil] = useState(0)
  const [, force] = useState(0) // re-render to release the lock when the cooldown elapses
  const submitting = useRef(false)

  const locked = Date.now() < lockedUntil
  const disabled = busy || locked

  // tick once a second while locked so the pad re-enables itself on time
  useEffect(() => {
    if (!locked) return
    const t = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [locked])

  const submit = async (value: string) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await onLogin(user.id, value)
      // success unmounts the whole LoginScreen via the auth gate — nothing else to do
    } catch (e: unknown) {
      setPin('') // wipe the failed attempt so the next try starts clean
      if (e instanceof ApiError) {
        setError(e.detail)
        if (e.status === 429) {
          const secs = e.retryAfter ?? 5
          setLockedUntil(Date.now() + secs * 1000)
        }
      } else {
        setError(appConfig.copy.login.loginFailed)
      }
    } finally {
      setBusy(false)
      submitting.current = false
    }
  }

  return (
    <PinPad
      value={pin}
      onChange={(next) => { setError(null); setPin(next) }}
      onComplete={(full) => void submit(full)} // auto-submit on the 6th digit
      disabled={disabled}
      message={error ?? (locked ? appConfig.copy.login.pleaseWait : undefined)}
      header={
        <button className="pin-backuser" onClick={onBack}>
          <Icon id="chevron" />
          <span className="pin-avatar" style={{ background: user.color ?? NEUTRAL_COLOR }}>{initials(user.display_name)}</span>
          <span className="pin-username">{user.display_name}</span>
        </button>
      }
    />
  )
}
