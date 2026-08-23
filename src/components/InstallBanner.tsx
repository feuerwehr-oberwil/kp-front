import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { dismissInstallBanner, onInstallStateChange, shouldShowBanner } from '../lib/installPrompt'
import { useMeldung } from '../lib/useMeldung'

// "Als App installieren" nudge — only in a plain browser tab (installed/standalone → never
// published), only on platforms with a real install path, and gone for good after ONE «Später»
// per device (localStorage; the IncidentSwitcher menu entry stays the permanent path — no
// re-nagging, the 3am rule). Last rank in the Meldeleiste: nothing waits on it.
// Self-contained: the workspace only mounts it and provides the guide opener.
export function InstallBanner({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => onInstallStateChange(() => bump((v) => v + 1)), [])

  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.install
  useMeldung(!shouldShowBanner() ? null : {
    id: 'install',
    kind: 'install',
    tone: 'calm',
    icon: 'snapshot',
    title: C.bannerTitle,
    sub: C.bannerHint,
    actions: [
      { label: C.bannerAction, primary: true, onClick: onOpenGuide },
      { label: C.dismiss, onClick: dismissInstallBanner },
    ],
  })
  return null
}
