import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'

/**
 * «Einsatz wurde auf einem anderen Gerät abgeschlossen (14:45)» — published by the workspace when
 * the Einsatz it shows was closed ELSEWHERE while it was open here (N3, staging 25.09.2026). The
 * screen has just turned read-only under the operator's hands; without a word that reads as a
 * frozen app. The row names what happened and when; where this device still had entries on the
 * way that the closed Einsatz no longer took, it says so and offers «Einträge sichern» — they are
 * kept on the device, never dropped. The ✕ is legitimate: the ArchivedChip beside the Einsatzname
 * keeps saying «Einsatz abgeschlossen» after the row is gone.
 */
export function IncidentClosedMeldung({ at, refused, onExport, onDismiss }: {
  /** epoch ms of the close (incidentClosed · closedNoticeAt) */
  at: number
  /** entries of this device the closed Einsatz refused (journal + audit + workspace saves) */
  refused: number
  onExport: () => void
  onDismiss: () => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.archived
  useMeldung({
    id: 'incident-closed',
    kind: 'closed',
    tone: refused > 0 ? 'warn' : 'info',
    icon: 'lock',
    title: fillTemplate(C.closedElsewhere, { t: formatTime(new Date(at)) }),
    sub: refused > 0
      ? (refused === 1 ? C.closedRefusedOne : fillTemplate(C.closedRefused, { n: refused }))
      : C.closedElsewhereSub,
    actions: refused > 0 ? [{ label: C.closedExport, icon: 'download', onClick: onExport }] : undefined,
    dismiss: { label: C.closedDismiss, onClick: onDismiss },
    wrap: true,
  })
  return null
}
