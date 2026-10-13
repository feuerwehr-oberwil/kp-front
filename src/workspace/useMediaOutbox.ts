// The operational outboxes' last mile: the media queue (a Foto / Sprachnotiz is not saved until
// the server has it), the ONE sync status the badge shows (records + media, amber while a closed
// Einsatz's refusals are unexported), «Jetzt synchronisieren» and the Abschluss's pre-close drain.
// Split out of IncidentWorkspace (E1, 09.10.2026) verbatim.

import { combinedSyncStatus } from '../lib/combinedSyncStatus'
import { WorkspaceSync, type IncidentMeta, type SyncStatus } from '../lib/incidents'
import { useAuditEvents } from '../lib/useAuditEvents'
import { useJournal } from '../lib/useJournal'
import { useMediaQueue } from '../lib/useMediaQueue'
import type { TimelineEvent } from '../types'
import { useCallback } from 'react'

export interface UseMediaOutboxInputs {
  swapPhoto: (id: string, from: string, to: string) => void
  overlayRow: (id: string, fields: Partial<TimelineEvent>) => void
  patchRow: (id: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'transcriptSection' | 'transcriptSectionEdit' | 'audioUrl' | 'photoUrl' | 'photoUrls' | 'textEdit' | 'retracted'>>) => void
  incidentMeta: IncidentMeta
  canWriteRecord: boolean
  closedRefusedTotal: number
  exportedClosedRefused: number
  recordsSyncStatus: SyncStatus
  syncWorkspaceNow: () => Promise<void>
  journal: ReturnType<typeof useJournal>
  auditDelivery: ReturnType<typeof useAuditEvents>
  sync: WorkspaceSync
  flushEvents: () => Promise<void>
}

export function useMediaOutbox({
  swapPhoto, overlayRow, patchRow, incidentMeta, canWriteRecord, closedRefusedTotal,
  exportedClosedRefused, recordsSyncStatus, syncWorkspaceNow, journal, auditDelivery, sync,
  flushEvents,
}: UseMediaOutboxInputs) {
  // Offline media queue: reattaches queued captures to their rows after a reload, retries on
  // reconnect, and swaps a row's local blob: URL for the persistent server URL on success.
  const swapRowMedia = useCallback((rowId: string, kind: 'photo' | 'audio', url: string, replaces?: string) => {
    // a persistent server URL becomes an appended enrichment patch (the record stays
    // append-only); a session blob: URL (queue restore) is a display-only overlay
    if (kind === 'photo') {
      // photos are a LIST: a queued upload that lands later must replace ITS OWN picture and
      // leave the row's others alone. The store reads the current list itself — a copy taken
      // here would be the one from whichever render created this callback (see swapPhoto).
      swapPhoto(rowId, replaces ?? '', url)
      return
    }
    if (url.startsWith('blob:')) overlayRow(rowId, { audioUrl: url })
    else patchRow(rowId, { audioUrl: url })
  }, [swapPhoto, overlayRow, patchRow])
  const media = useMediaQueue({
    incidentId: incidentMeta.id, readOnly: !canWriteRecord,
    onUploaded: swapRowMedia, onRestore: swapRowMedia,
  })
  // ⚠️ The media queue is an operational outbox too (23.09.2026): a Foto or Sprachnotiz that has
  // not reached the server is not saved, and one this device could not even store is `storage`.
  // It used to be left out, so the badge said «gespeichert» over captures that lived only here.
  // ⚠️ …and entries the CLOSED Einsatz refused keep the lamp amber (review of #235) until they
  // are exported or sent after a reopen: not red — nobody can fix them by retrying — but not
  // «gespeichert» either, because they are on this device only.
  const closedRefusedUnexported = closedRefusedTotal > exportedClosedRefused
  const baseSyncStatus = combinedSyncStatus(recordsSyncStatus, media.syncStatus)
  const syncStatus = closedRefusedUnexported && baseSyncStatus === 'synced' ? 'pending' : baseSyncStatus
  const syncNow = async () => {
    await Promise.all([syncWorkspaceNow(), journal.retry(), auditDelivery.retry()])
    await media.flush({ retry: true }).catch(() => {})
    if (combinedSyncStatus(sync.syncStatus, journal.getStatus(), auditDelivery.getStatus(), media.getStatus()) !== 'synced') {
      throw new Error('Operational records have not all been acknowledged')
    }
  }

  /** the closing device's own queue, drained before the archive PATCH (useAbschluss) */
  const { flush: flushJournal } = journal
  const flushRecordOutboxes = useCallback(async () => {
    await Promise.all([flushJournal(), flushEvents()]).catch(() => {})
  }, [flushJournal, flushEvents])
  return { media, flushRecordOutboxes, swapRowMedia, syncStatus, closedRefusedUnexported, baseSyncStatus, syncNow }
}
