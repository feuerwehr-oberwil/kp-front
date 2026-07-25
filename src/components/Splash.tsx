import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { deploymentName } from '../lib/deploymentConfig'

/**
 * Shared boot screen: the brand pulse + station wordmark, optionally a status line.
 * Every pre-incident loading stage (auth probe, incident-list fetch, admin chunk,
 * symbol library) renders this, so a cold launch reads as one continuous sequence —
 * no blank colour flash, no jump between layouts. The 3am tenet: the operator always
 * sees the system is alive and starting, never a dead screen.
 *
 * `inApp` switches from the full-screen pre-app cover (own background, above the login
 * layer) to the lighter in-workspace overlay used once an incident is mounted and the
 * TopBar is already painted.
 */

/** How long a launch may pulse silently before the splash admits something is wrong. Past a
 *  few seconds "alive and starting" stops reassuring and starts being a dead end, so the
 *  splash names the problem and offers the one action that helps. Every request on the boot
 *  path is itself time-bounded (api.ts), so reaching this is already unusual — but a wedged
 *  lazy chunk or a stalled service worker carries no such bound, and those are exactly the
 *  cases where the operator otherwise has nothing on screen to tap. */
const STUCK_MS = 9_000

export function Splash({ sub, inApp }: { sub?: string; inApp?: boolean }) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setStuck(true), STUCK_MS)
    return () => clearTimeout(t)
  }, [])
  const c = appConfig.copy.splash
  return (
    <div className={inApp ? 'loading' : 'login splash'}>
      <div className="loading-card">
        <div className="ping"><span /><span /><span className="core" /></div>
        <div className="loading-name">{deploymentName()}</div>
        {sub && <div className="loading-sub">{sub}</div>}
        {stuck && (
          <div className="loading-stuck" role="status">
            <div className="loading-stuck-title">{c.stuck}</div>
            <p className="loading-stuck-hint">{c.stuckHint}</p>
            <button type="button" className="ip-btn primary" onClick={() => location.reload()}>
              {c.reload}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
