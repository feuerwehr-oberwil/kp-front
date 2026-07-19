import { useEffect, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { dismissInstallBanner, onInstallStateChange, shouldShowBanner } from '../lib/installPrompt'

// "Als App installieren" nudge — only in a plain browser tab (installed/standalone → never
// rendered), only on platforms with a real install path, and gone for good after ONE «Später»
// per device (localStorage; the IncidentSwitcher menu entry stays the permanent path — no
// re-nagging, the 3am rule). Reuses the UpdateBanner glass card; a CSS sibling rule steps it
// up when both banners are visible at once. Self-contained: App only mounts it and provides
// the guide opener.
export function InstallBanner({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => onInstallStateChange(() => bump((v) => v + 1)), [])

  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.install
  if (!shouldShowBanner()) return null
  return (
    <div className="update-banner install-banner" role="status">
      <Icon id="snapshot" />
      <div className="ub-text">
        <span className="ub-title">{C.bannerTitle}</span>
        <span className="ub-hint">{C.bannerHint}</span>
      </div>
      <button className="ub-btn ub-reload" onClick={onOpenGuide}>{C.bannerAction}</button>
      <button className="ub-btn ub-later" onClick={dismissInstallBanner}>{C.dismiss}</button>
    </div>
  )
}
