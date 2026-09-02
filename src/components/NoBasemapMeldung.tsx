import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'

// Published when a BASE tile fails while the device is offline (MapView · onBasemapUnavailable):
// the map is a flat colour with symbols and lines on it, and nothing on screen said why. The row
// names the cause and leads to the Offline-Bereitschaft sheet, where the area can be prepared for
// next time. Once per Einsatz mount, gone the moment the link is back (IncidentWorkspace).
export function NoBasemapMeldung({ onOpenOffline, onDismiss }: { onOpenOffline: () => void; onDismiss: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.map
  useMeldung({
    id: 'basemap',
    kind: 'basemap',
    tone: 'warn',
    icon: 'layers',
    title: C.noTilesTitle,
    sub: C.noTilesSub,
    actions: [{ label: C.noTilesAction, onClick: onOpenOffline }],
    dismiss: { label: C.noTilesDismiss, onClick: onDismiss },
  })
  return null
}
