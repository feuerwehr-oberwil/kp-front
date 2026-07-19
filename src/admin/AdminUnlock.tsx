import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { ApiError } from '../lib/api'
import { adminLogin } from './adminAuth'

// Admin-secret unlock gate. Shown after a user is logged in (for audit identity) but before
// the admin shell, whenever this browser holds no valid admin session. Admin authority is the
// deployment ADMIN_SECRET — separate from the incident editor role.
export function AdminUnlock({ onUnlocked, onLogout }: { onUnlocked: () => void; onLogout: () => void }) {
  const c = appConfig.copy.admin.unlock
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !secret) return
    setBusy(true)
    setError(null)
    try {
      await adminLogin(secret)
      setSecret('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="adm-denied">
      <form className="adm-denied-card" onSubmit={submit}>
        <h1 className="adm-denied-title">{c.title}</h1>
        <p className="adm-denied-tx">{c.body}</p>
        <div className="adm-field adm-denied-field">
          <label className="adm-field-label" htmlFor="adm-secret">{c.label}</label>
          {/* hidden username anchors the keychain entry so Safari/iOS offer to save the
              admin secret (a lone password field is often skipped by password managers) */}
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
          <input
            id="adm-secret"
            name="password"
            className="adm-input adm-input-mono"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={secret}
            onChange={(ev) => setSecret(ev.target.value)}
            disabled={busy}
          />
          {error && <span className="adm-field-hint err" role="alert">{error}</span>}
        </div>
        <div className="adm-denied-actions">
          <button type="submit" className="btn primary" disabled={busy || !secret}>
            {busy ? c.submitting : c.submit}
          </button>
          <button type="button" className="btn" onClick={onLogout} disabled={busy}>{c.logout}</button>
        </div>
      </form>
    </div>
  )
}
