import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'
import { useOnline } from '../lib/useOnline'

// Published while the Einsatz's sync status is `storage` (S1, 20.10.2026): local storage is
// full, so what is captured now lives only in this app session and is lost when it closes. It
// was a chip in the Einsatz pill alone — on a phone a bare glyph — while the milder «Sync-Fehler»
// at least had its sentence in the menu. This is the one state that loses work, so it stands in
// the Meldeleiste right after the lifecycle row (lib/meldungen · storage), stays while true and
// has no ✕.
//
// The two moves that actually help: «Einträge sichern» downloads everything this device still
// holds that the server has not taken (useLifecycleElsewhere · exportEntries — the Verlauf, the
// audit trail, refused saves; works offline), and online «Jetzt synchronisieren» hands it all to
// the server, after which nothing depends on the full store any more.
export function StorageFullMeldung({ onExport, onSyncNow }: {
  onExport: () => void
  /** resolves once every queue is acknowledged, rejects otherwise — the row stays either way
   *  until the status itself changes */
  onSyncNow: () => Promise<void>
}) {
  const online = useOnline()
  const [syncing, setSyncing] = useState(false)
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.incidentSwitcher
  const sync = () => {
    if (syncing) return
    setSyncing(true)
    void onSyncNow().catch(() => {}).finally(() => setSyncing(false))
  }
  useMeldung({
    id: 'storage',
    kind: 'storage',
    tone: 'alarm',
    icon: 'storage',
    title: C.storageMeldung,
    sub: C.storageMeldungSub,
    // the sentence is the instruction — cut at 390px it would lose «… gehen sie sonst verloren»
    wrap: true,
    actions: [
      { label: appConfig.copy.journal.delivery.export, icon: 'download', primary: true, onClick: onExport },
      // offline the tap could only end in «Immer noch offline» (IncidentSwitcher · syncButton)
      ...(online ? [{ label: C.syncNow, icon: 'rotate', busy: syncing, disabled: syncing, onClick: sync }] : []),
    ],
  })
  return null
}
