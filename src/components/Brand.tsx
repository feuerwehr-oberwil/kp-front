import { deploymentName, deploymentLogo } from '../lib/deploymentConfig'

/**
 * Static brand lockup — deployment logo + station wordmark + an optional sub line.
 * Shared by the login kiosk and the empty-incident state so the two pre-incident
 * surfaces read identically and always show the station's configured mark (never a
 * hand-copied favicon path). The boot pulse is its own surface ([[Splash]]).
 */
export function Brand({ sub, className }: { sub?: string; className?: string }) {
  return (
    <div className={`login-brand${className ? ` ${className}` : ''}`}>
      <img className="login-logo" src={deploymentLogo()} alt="" width="44" height="44" />
      <div className="login-brandtx">
        <div className="login-name">{deploymentName()}</div>
        {sub != null && <div className="login-sub">{sub}</div>}
      </div>
    </div>
  )
}
