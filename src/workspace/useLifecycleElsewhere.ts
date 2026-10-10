// The Einsatz closed — or reopened — on ANOTHER device while it was open here (N3, 25.09.2026):
// what this device still holds that the closed Einsatz refused, handing it over once after a close,
// sending it again after a reopen, «Einträge sichern», and how long the Meldeleiste row stands.
// Split out of IncidentWorkspace (E1, 09.10.2026) verbatim; the row itself is still rendered there.

import { downloadBlob } from '../lib/download'
import { WorkspaceSync, type IncidentMeta } from '../lib/incidents'
import { latestLifecycle } from '../lib/reopenClocks'
import { useAuditEvents } from '../lib/useAuditEvents'
import { useExpire } from '../lib/useExpire'
import { useJournal } from '../lib/useJournal'
import { useCallback, useEffect, useMemo, useState } from 'react'

/** How long the «auf einem anderen Gerät abgeschlossen / wieder geöffnet» row stands (V2). */
const LIFECYCLE_NOTICE_MS = 120_000

export interface UseLifecycleElsewhereInputs {
  sync: WorkspaceSync
  journal: ReturnType<typeof useJournal>
  auditDelivery: ReturnType<typeof useAuditEvents>
  running: boolean
  flushEvents: () => Promise<void>
  outboxReadOnly: boolean
  incidentMeta: IncidentMeta
  lifecycleElsewhere: { event: 'closed' | 'reopened'; at: number } | null | undefined
}

export function useLifecycleElsewhere({
  sync, journal, auditDelivery, running, flushEvents, outboxReadOnly, incidentMeta, lifecycleElsewhere,
}: UseLifecycleElsewhereInputs) {
  // --- closed (or reopened) on ANOTHER device while open here (N3, staging 25.09.2026) ---------
  // App flips `incidentMeta` in place when the change is heard (App · onIncidentClosed /
  // onIncidentReopened) and hands the moment down (`lifecycleElsewhere`); `running` above turns
  // every writer off — or back on. Left for this mount: say so (one Meldeleiste row, with the
  // time), hand what is still queued to the server once after a close — so it is refused and
  // PARKED rather than left pending in a read-only view — and count what was parked, because
  // «nicht übernommen, aber gesichert» is the other half of the sentence. Once the Einsatz runs
  // again («Wieder öffnen», here or elsewhere), what was parked is SENT — it prints as Nachträge.
  const [lifecycleHiddenAt, setLifecycleHiddenAt] = useState<number | null>(null)
  const [workspaceRefused, setWorkspaceRefused] = useState(() => sync.refusedCount)
  useEffect(() => sync.subscribeRefused(setWorkspaceRefused), [sync])
  /** everything the CLOSED Einsatz refused and this device still holds (journal · audit · saves) */
  const closedRefusedTotal = journal.refusedCount + auditDelivery.closedCount + workspaceRefused
  useEffect(() => {
    if (running) return
    // the journal store drains on its own loop (outboxReadOnly keeps it delivering); these two
    // wait for their next trigger otherwise. Both are no-ops with nothing queued.
    void sync.flush()
    void flushEvents()
  }, [running, sync, flushEvents])
  // …and once it RUNS again with anything parked — a reopen seen on screen, or a device opening
  // an Einsatz that was reopened while it was away — the parked entries are owed again. How many
  // went is remembered for the reopen's row («werden jetzt nachgesendet»).
  const [resentOnReopen, setResentOnReopen] = useState(0)
  const { requeueRefused: requeueJournal } = journal
  const { requeueClosed: requeueAudit } = auditDelivery
  useEffect(() => {
    if (!running || outboxReadOnly || closedRefusedTotal === 0) return
    const n = closedRefusedTotal
    void Promise.all([requeueJournal(), requeueAudit(), sync.requeueRefused()]).catch(() => {}).then(() => setResentOnReopen(n))
  }, [running, outboxReadOnly, closedRefusedTotal, requeueJournal, requeueAudit, sync])
  /** «Einträge sichern»: everything this device still holds that the server has not taken — owed
   *  (outbox, rejected) and refused (the closed Einsatz, a role) alike. Exporting acknowledges
   *  nothing — but it is what lets the sync lamp stop saying «not everything is on the server»
   *  about entries the closed Einsatz refused (see `syncStatus` below). */
  const [exportedClosedRefused, setExportedClosedRefused] = useState(0)
  const exportEntries = useCallback(() => {
    const data = { ...journal.recoveryData(), audit: auditDelivery.getRecoveryData(), workspaceRefused: sync.refusedRecoveryData() }
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `verlauf-${incidentMeta.id}.json`)
    setExportedClosedRefused(closedRefusedTotal)
  }, [journal, auditDelivery, sync, incidentMeta.id, closedRefusedTotal])
  // the newest close/reopen boundary in the Verlauf, the server's own rows (lib/reopenClocks) —
  // the reopen's clock restart keys on it below, and the reopen's row names ITS time (N6)
  const lifecycleBoundary = useMemo(() => latestLifecycle(journal.rows), [journal.rows])
  const lifecycleRefused = lifecycleElsewhere?.event === 'closed' ? closedRefusedTotal : resentOnReopen
  // ⚠️ …and it EXPIRES (V2, staging 25.09.2026): «wieder geöffnet» sat 110 px tall on a 360 phone
  // until somebody found the ✕. Two minutes, like every notice that only informs — unless it
  // carries entries this device still holds, whose «Einträge sichern» must not vanish unseen.
  useExpire(lifecycleElsewhere?.at ?? null, LIFECYCLE_NOTICE_MS, lifecycleRefused > 0, setLifecycleHiddenAt)
  return { lifecycleHiddenAt, lifecycleBoundary, lifecycleRefused, exportEntries, setLifecycleHiddenAt, closedRefusedTotal, exportedClosedRefused }
}
