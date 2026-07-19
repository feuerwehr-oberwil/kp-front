import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { AdminShell } from './AdminShell'
import { AdminUnlock } from './AdminUnlock'
import { adminLogout, getAdminSession } from './adminAuth'
import { appConfig } from '../config/appConfig'
import { Splash } from '../components/Splash'
import './admin.css'

type AdminGate = 'probing' | 'disabled' | 'locked' | 'unlocked'

// Admin entry — its own lazy chunk (see main.tsx), so field users never download any of
// this. ONE gate: the deployment ADMIN_SECRET — independent of the kiosk roster login
// (decision 2026-07-08; shared read/write endpoints accept the admin session via
// UserOrAdmin/EditorOrAdmin). A kiosk session, when present, still stamps updated_by
// for audit; without one the stamps are NULL, same as the CLI.
export default function AdminApp() {
  const { logout } = useAuth()
  const [gate, setGate] = useState<AdminGate>('probing')

  useEffect(() => {
    document.title = `KP Front — ${appConfig.copy.admin.shell.verwaltung}`
  }, [])

  useEffect(() => {
    let alive = true
    getAdminSession()
      .then((s) => {
        if (!alive) return
        setGate(!s.configured ? 'disabled' : s.authenticated ? 'unlocked' : 'locked')
      })
      .catch(() => { if (alive) setGate('locked') })
    return () => { alive = false }
  }, [])

  // Logging out of admin clears the admin session and any kiosk session (best-effort).
  const fullLogout = useCallback(async () => {
    try { await adminLogout() } catch { /* best-effort */ }
    await logout().catch(() => {})
  }, [logout])

  if (gate === 'probing') return <Splash />

  if (gate === 'disabled') {
    const c = appConfig.copy.admin.unlock
    return (
      <div className="adm-denied">
        <div className="adm-denied-card">
          <h1 className="adm-denied-title">{c.disabledTitle}</h1>
          <p className="adm-denied-tx">{c.disabledBody}</p>
          <div className="adm-denied-actions">
            <a className="btn primary" href="/">{appConfig.copy.admin.shell.toLageMap}</a>
            <button type="button" className="btn" onClick={() => void fullLogout()}>{appConfig.copy.admin.shell.logout}</button>
          </div>
        </div>
      </div>
    )
  }

  if (gate === 'locked') {
    return <AdminUnlock onUnlocked={() => setGate('unlocked')} onLogout={() => void fullLogout()} />
  }

  return <AdminShell />
}
