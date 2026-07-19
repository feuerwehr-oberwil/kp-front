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
export function Splash({ sub, inApp }: { sub?: string; inApp?: boolean }) {
  return (
    <div className={inApp ? 'loading' : 'login splash'}>
      <div className="loading-card">
        <div className="ping"><span /><span /><span className="core" /></div>
        <div className="loading-name">{deploymentName()}</div>
        {sub && <div className="loading-sub">{sub}</div>}
      </div>
    </div>
  )
}
