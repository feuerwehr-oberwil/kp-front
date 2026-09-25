import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { useMeldung } from '../lib/useMeldung'

/**
 * «Einsatz wurde auf einem anderen Gerät abgeschlossen (14:45)» — and its mirror, «… wieder
 * geöffnet (15:10)». Published by the workspace when the Einsatz on screen changed its lifecycle
 * ELSEWHERE while it was open here (N3, staging 25.09.2026). The screen has just turned read-only
 * (or live again) under the operator's hands; without a word that reads as a frozen — or a
 * suddenly unlocked — app.
 *
 * `refused` counts this device's entries the closed Einsatz did not take. After a close the row
 * says so and offers «Einträge sichern»; after a reopen it says they STAY set aside — a reopen
 * does not re-send them — and still offers the export. Kept on the device either way, never
 * dropped. The ✕ is legitimate: the chip beside the Einsatzname (or its absence) keeps saying
 * which state the Einsatz is in after the row is gone.
 */
export function IncidentClosedMeldung({ event, at, refused, onExport, onDismiss, forLink = false }: {
  event: 'closed' | 'reopened'
  /** the Atemschutz-Link page (staging r3): its holder cannot reopen the Einsatz, so the closed
   *  row never says «zum Bearbeiten wieder öffnen» — it says what the board still is */
  forLink?: boolean
  /** epoch ms of the change (incidentClosed · closedNoticeAt, or when the reopen was heard) */
  at: number
  /** entries of this device the closed Einsatz refused (journal + audit + workspace saves) */
  refused: number
  onExport: () => void
  onDismiss: () => void
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.archived
  const closed = event === 'closed'
  const sub = closed
    ? (refused > 0 ? (refused === 1 ? C.closedRefusedOne : fillTemplate(C.closedRefused, { n: refused })) : C.closedElsewhereSub)
    : (refused > 0 ? (refused === 1 ? C.reopenedParkedOne : fillTemplate(C.reopenedParked, { n: refused })) : C.reopenedElsewhereSub)
  useMeldung({
    // one id for both: a reopen replaces the close's row rather than standing under it
    id: 'incident-lifecycle',
    kind: 'lifecycle',
    tone: closed && refused > 0 ? 'warn' : 'info',
    icon: closed ? 'lock' : 'pen',
    title: closed && forLink ? C.linkClosedTitle : fillTemplate(closed ? C.closedElsewhere : C.reopenedElsewhere, { t: formatTime(new Date(at)) }),
    sub: closed && forLink && refused === 0 ? undefined : sub,
    actions: refused > 0 ? [{ label: C.closedExport, icon: 'download', onClick: onExport }] : undefined,
    dismiss: { label: C.closedDismiss, onClick: onDismiss },
    wrap: true,
  })
  return null
}

/**
 * The Atemschutz-Link was refused on its own Einsatz (D1): revoked, or dead for a reason the
 * server does not tell a link holder. The Tafel is frozen read-only (IncidentWorkspace ·
 * linkRefused) and this row says so — never «Sync-Fehler – lokal gespeichert» over entries that
 * can never be delivered. No ✕: it stays true for as long as the page is open.
 */
export function LinkRefusedMeldung() {
  const C = appConfig.copy.archived
  useMeldung({
    id: 'link-refused',
    kind: 'lifecycle',
    tone: 'warn',
    icon: 'lock',
    title: C.linkRefusedTitle,
    wrap: true,
  })
  return null
}
