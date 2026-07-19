import { appConfig } from '../config/appConfig'
import { isDemoMode } from '../lib/deploymentConfig'

/**
 * Persistent "DEMO" marker for demo deployments — a small fixed corner ribbon shown on
 * every screen so a visitor is never in doubt this isn't a live incident. Renders nothing
 * unless `identity.demoMode` is set in the deployment config (so real stations never see it).
 * Non-interactive; pinned above the app chrome and out of the way of controls.
 */
export function DemoRibbon() {
  if (!isDemoMode()) return null
  const c = appConfig.copy.demo
  return (
    <div className="demo-ribbon" role="note" aria-label={c.ariaLabel}>
      {c.ribbon}
    </div>
  )
}
