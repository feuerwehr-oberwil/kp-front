import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'

/** A closed Einsatz whose Fotos / Sprachnotizen are still only on this device. */
export interface ClosedMediaPending {
  id: string
  title: string
  n: number
}

// Published after an Abschluss that left captures in the media queue (App · completeRapport, S3
// 20.10.2026). It was the closing toast's second half — «… {n} Foto/Audio noch nicht hochgeladen»
// for five seconds, while the operator was being moved to the launcher — so a device could hold
// the only copy of a picture with nothing on screen saying so. It stands while the queue still
// holds them (App re-reads it with every list refresh) and may be waved away: the captures are
// safe on the device, nobody has to act now.
export function MediaPendingMeldung({ pending, onDismiss }: { pending: ClosedMediaPending; onDismiss: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.abschluss
  useMeldung({
    id: `media:${pending.id}`,
    kind: 'media',
    tone: 'warn',
    icon: 'upload',
    title: fillTemplate(C.mediaPendingTitle, { n: pending.n, title: pending.title }),
    sub: C.mediaPendingSub,
    wrap: true,
    dismiss: { label: C.mediaPendingDismiss, onClick: onDismiss },
  })
  return null
}
