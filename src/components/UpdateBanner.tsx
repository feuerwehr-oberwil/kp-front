import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { onUpdateAvailable } from '../lib/swUpdate'
import { useMeldung } from '../lib/useMeldung'

// Non-blocking "a new build is ready" message. registerType is 'prompt', so a fresh deploy
// installs and WAITS instead of reloading the app mid-incident; updates found at boot apply
// silently (swUpdate), so this only appears for deploys that land while the operator is already
// working. It ANNOUNCES only: the new version becomes active on the next app start (full close +
// reopen) — the in-place «Neu laden» was removed because skipWaiting activation is unreliable on
// iOS standalone, while a restart always works (decision 2026-07-09). Dismissible, and it
// re-appears on the next deploy. Self-contained: it owns its visibility off the swUpdate
// subscription, so the workspace only has to mount it.
//
// Rank 6 of 7 in the Meldeleiste: the calmest thing there is, and the reason the strip ranks by
// CLASS rather than arrival — it used to sit at the bottom edge on the same coordinate as three
// other cards, and a deploy landing at 3am must never be what the operator reads first.
export function UpdateBanner() {
  const [available, setAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // A fresh waiting build re-shows the message even if a previous one was dismissed; an
  // update that resolves on its own (the announced worker took over) retracts it.
  useEffect(() => onUpdateAvailable((avail) => { setAvailable(avail); if (avail) setDismissed(false) }), [])

  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.update
  useMeldung(!available || dismissed ? null : {
    id: 'update',
    kind: 'update',
    tone: 'calm',
    icon: 'info',
    title: C.available,
    sub: C.hint,
    dismiss: { label: C.dismiss, onClick: () => setDismissed(true) },
  })
  return null
}
