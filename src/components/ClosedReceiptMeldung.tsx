import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'

/** What this device's close knew of the Einsatz it just closed (useIncidentLifecycle · completeRapport). */
export interface ClosedReceipt {
  id: string
  title: string
  /** the Rapport's Einsatzende the close kept or wrote (ISO); absent when the close did not know it */
  endedAt?: string
  /** when the Rapport was made – a PDF or a finished print (ReportMeta.reportMadeAt); absent: none */
  reportMadeAt?: string
}

// The receipt of a close (owner pick UX journeys B2·13, 25.11.2026). It overturns pick 28
// (17.11.2026, «the screen moving to the launcher says it happened»): both walkers landed on a
// launcher with no word and asked «Did it work? Where is my Rapport?». So the launcher's
// Meldeleiste carries «Einsatz abgeschlossen» with the Einsatzende and the Rapport's time until
// «Ausblenden» – a standing row like MediaPendingMeldung, not a toast that goes while the screen
// changes. «Rapport öffnen» opens the closed Einsatz on its Rapport, read-only.
export function ClosedReceiptMeldung({ receipt, onOpenRapport, onDismiss }: {
  receipt: ClosedReceipt
  onOpenRapport: () => void
  onDismiss: () => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const A = appConfig.copy.abschluss
  const at = (iso: string) => formatTime(new Date(iso))
  useMeldung({
    id: `closed:${receipt.id}`,
    kind: 'closed',
    tone: 'calm',
    icon: 'check',
    title: A.closedTitle,
    sub: [receipt.title.trim(), receipt.endedAt ? fillTemplate(A.closedEnde, { t: at(receipt.endedAt) }) : '']
      .filter(Boolean).join(' · '),
    sub2: receipt.reportMadeAt ? fillTemplate(A.closedReport, { t: at(receipt.reportMadeAt) }) : A.reportMissing,
    wrap: true,
    actions: [{ label: A.closedOpenRapport, onClick: onOpenRapport }],
    dismiss: { label: A.mediaPendingDismiss, onClick: onDismiss },
  })
  return null
}
