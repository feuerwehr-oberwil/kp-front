import { useEffect, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { onUpdateAvailable } from '../lib/swUpdate'

// Non-blocking "a new build is ready" banner. registerType is 'prompt', so a fresh deploy
// installs and WAITS instead of reloading the app mid-incident; updates found at boot apply
// silently (swUpdate), so the banner only appears for deploys that land while the operator
// is already working. It ANNOUNCES only: the new version becomes active on the next app
// start (full close + reopen) — the in-place «Neu laden» was removed because skipWaiting
// activation is unreliable on iOS standalone, while a restart always works (decision
// 2026-07-09). Calm and low in the layout, below the safety-critical banners (reminders);
// dismissible, and it re-appears on the next deploy. Self-contained: it owns its visibility
// off the swUpdate subscription, so App only has to mount it.
export function UpdateBanner() {
  const [available, setAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // A fresh waiting build re-shows the banner even if a previous one was dismissed; an
  // update that resolves on its own (the announced worker took over) retracts it.
  useEffect(() => onUpdateAvailable((avail) => { setAvailable(avail); if (avail) setDismissed(false) }), [])

  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.update
  if (!available || dismissed) return null
  return (
    <div className="update-banner" role="status">
      <Icon id="info" />
      <div className="ub-text">
        <span className="ub-title">{C.available}</span>
        <span className="ub-hint">{C.hint}</span>
      </div>
      <button className="ub-btn ub-later" onClick={() => setDismissed(true)}>{C.dismiss}</button>
    </div>
  )
}
