import { useEffect, useState } from 'react'
import type { SyncStatus } from '../lib/incidents'
import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'
import { createOfflinePresence } from '../lib/syncAlert'

// Published while the device has been offline past the grace window (syncAlert ·
// createOfflinePresence, 60 s) — the one-shot toast is gone in seconds, and a tablet in a
// cellar then edited on for half an hour with nothing on screen saying the others see none of
// it (field request 07.09., half-reversing the 2026-07-18 «no permanent banner» decision).
// No ✕: the row is true until the link is back, and the link coming back withdraws it.
// «Jetzt synchronisieren» is the same hand-crank the switcher offers.
export function OfflineMeldung({ status, onSyncNow }: { status: SyncStatus; onSyncNow: () => void }) {
  const [standing, setStanding] = useState(false)
  // one tracker per mount — it owns the 60 s persistence clock across status flaps
  const [tracker] = useState(() => createOfflinePresence(setStanding))
  useEffect(() => { tracker.onStatus(status) }, [tracker, status])
  useEffect(() => () => tracker.dispose(), [tracker])
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.incidentSwitcher
  useMeldung(standing ? {
    id: 'offline',
    kind: 'offline',
    tone: 'warn',
    icon: 'warn',
    title: C.offlineMeldungTitle,
    sub: C.offlineMeldungSub,
    actions: [{ label: C.syncNow, onClick: onSyncNow }],
  } : null)
  return null
}
