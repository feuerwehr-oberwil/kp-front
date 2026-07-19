import { useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { useAuth, type RosterEntry } from '../lib/auth'
import { Brand } from './Brand'
import { demoNote } from '../lib/deploymentConfig'
import { IconSprite, Icon } from '../lib/icons'
import { initials, roleLabel } from '../lib/format'
import { appConfig } from '../config/appConfig'

const PIN_LENGTH = 6
const NEUTRAL_COLOR = '#6c7686' // --ink-faint, for roster tiles without an assigned colour

// Kiosk login gate. Built for fast, gloved 3am use on shared station/vehicle
// tablets: pick a face (no typed identity), then tap a 6-digit PIN. Matches the
// "Karte Minimal" dark tactical language.
export function LoginScreen() {
  const { login } = useAuth()
  const [roster, setRoster] = useState<RosterEntry[] | null>(null)
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RosterEntry | null>(null)

  useEffect(() => {
    let alive = true
    apiGet<RosterEntry[]>('/api/auth/roster')
      .then((r) => { if (alive) setRoster(r) })
      .catch((e: unknown) => {
        if (!alive) return
        setRosterError(e instanceof ApiError ? e.detail : appConfig.copy.login.connectionFailed)
      })
    return () => { alive = false }
  }, [])

  return (
    <div className="login">
      <IconSprite />
      <div className="login-card">
        <Brand sub={selected ? appConfig.copy.login.pinEnter : appConfig.copy.login.subtitle} />

        {demoNote() && <p className="login-demo-note">{demoNote()}</p>}

        {selected
          ? <PinPad user={selected} onLogin={login} onBack={() => setSelected(null)} />
          : <Roster roster={roster} error={rosterError} onPick={setSelected} />}
      </div>
    </div>
  )
}

function Roster({ roster, error, onPick }: {
  roster: RosterEntry[] | null
  error: string | null
  onPick: (r: RosterEntry) => void
}) {
  if (error) {
    return (
      <div className="login-state login-state-err">
        <Icon id="warn" />
        <span>{error}</span>
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

function PinPad({ user, onLogin, onBack }: {
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

  const press = (digit: string) => {
    if (disabled || pin.length >= PIN_LENGTH) return
    setError(null)
    const next = pin + digit
    setPin(next)
    if (next.length === PIN_LENGTH) void submit(next) // auto-submit on the 6th digit
  }
  const backspace = () => { if (!disabled) setPin((p) => p.slice(0, -1)) }

  // Physical keyboard: digits append, Backspace deletes, Enter submits a full PIN.
  // Mirrors the on-screen pad; inert while the cooldown lock disables it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key) }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); backspace() }
      else if (e.key === 'Enter') { e.preventDefault(); if (pin.length === PIN_LENGTH) void submit(pin) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pin, disabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const keys: (string | 'back')[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back']

  return (
    <div className="pinpad">
      <button className="pin-backuser" onClick={onBack}>
        <Icon id="chevron" />
        <span className="pin-avatar" style={{ background: user.color ?? NEUTRAL_COLOR }}>{initials(user.display_name)}</span>
        <span className="pin-username">{user.display_name}</span>
      </button>

      <div className={`pin-dots ${error ? 'err' : ''}`}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <span key={i} className={`pin-dot ${i < pin.length ? 'on' : ''}`} />
        ))}
      </div>

      <div className="pin-msg" role="status">
        {error ?? (locked ? appConfig.copy.login.pleaseWait :' ')}
      </div>

      <div className="pin-grid">
        {keys.map((k, i) => {
          if (k === '') return <span key={i} className="pin-key-spacer" />
          if (k === 'back') {
            return (
              <button key={i} className="pin-key pin-key-fn" onClick={backspace} disabled={disabled || pin.length === 0} aria-label={appConfig.copy.login.clearDigit}>
                <Icon id="close" />
              </button>
            )
          }
          return (
            <button key={i} className="pin-key" onClick={() => press(k)} disabled={disabled}>{k}</button>
          )
        })}
      </div>
    </div>
  )
}
