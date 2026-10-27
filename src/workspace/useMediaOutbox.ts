// The operational outboxes' last mile: the media queue (a Foto / Sprachnotiz is not saved until
// the server has it), the ONE sync status the badge shows (records + media, amber while a closed
// Einsatz's refusals are unexported), «Jetzt synchronisieren» and the Abschluss's pre-close drain.
// Split out of IncidentWorkspace (E1, 09.10.2026) verbatim.
// Rapport-Beilagen share the queue, but never enrich a journal row: their target is explicit,
// and their callback updates an existing attachment (and its undo snapshot) by attachment id.
//
// ⚠️ An upload is linked to its Verlauf row from a RECEIPT (lib/mediaQueue header, audit F06,
// 26.10.2026), replayed until `linkUploaded` says the link is acknowledged — and that means the
// Verlauf outbox has DELIVERED everything it holds (`journal.getStatus() === 'synced'`), the
// patch included. The journal exposes no «this append is written to IndexedDB» signal (its
// `pending` is both «writing» and «written, unsent»), so the server's acknowledgement is the
// honest one; a receipt lives a little longer, only while the Verlauf is unsaved anyway. Linking
// is idempotent: a row that already carries the URL is not patched again (cross-session), and
// a link made in this session is not made twice from a stale render (`linked`). Nothing is
// linked before the journal has loaded (`journal.rowShown` is undefined) — a photo patch carries
// the row's WHOLE list and would hide pictures it cannot see; a row the loaded journal does not
// show (retracted, or none) gets no link, and its receipt retires once the Verlauf is synced.
//
// A Beilage's receipt (`target: 'attachment'`) is never a Verlauf patch: it goes to
// `swapAttachmentMedia`, and «acknowledged» is the WORKSPACE's word, where the Beilage lives —
// the swap is committed at once (flushSync, so the workspace's save effect has seen it before
// the check), and the receipt retires once the workspace holds nothing unsynced
// (`sync.hasUnsynced`). A swap that changed nothing (the URL is already there, or the Beilage was
// deleted — never recreated) saves nothing and retires at once.

import { combinedSyncStatus } from '../lib/combinedSyncStatus'
import type { IncidentMeta, SyncStatus, WorkspaceSync } from '../lib/incidents'
import type { useAuditEvents } from '../lib/useAuditEvents'
import type { useJournal } from '../lib/useJournal'
import { useMediaQueue } from '../lib/useMediaQueue'
import type { MediaTarget } from '../lib/mediaQueue'
import { rowPhotos } from '../lib/verlauf'
import type { TimelineEvent } from '../types'
import { useCallback, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

export interface UseMediaOutboxInputs {
  swapPhoto: (id: string, from: string, to: string) => void
  swapAttachmentMedia: (id: string, url: string) => void
  overlayRow: (id: string, fields: Partial<TimelineEvent>) => void
  patchRow: (id: string, fields: Partial<Pick<TimelineEvent, 'transcript' | 'transcriptSection' | 'transcriptSectionEdit' | 'audioUrl' | 'photoUrl' | 'photoUrls' | 'textEdit' | 'retracted'>>) => void
  incidentMeta: Pick<IncidentMeta, 'id'>
  canWriteRecord: boolean
  closedRefusedTotal: number
  exportedClosedRefused: number
  recordsSyncStatus: SyncStatus
  syncWorkspaceNow: () => Promise<void>
  journal: Pick<ReturnType<typeof useJournal>, 'rows' | 'getStatus' | 'rowShown' | 'retry' | 'flush'>
  auditDelivery: Pick<ReturnType<typeof useAuditEvents>, 'retry' | 'getStatus'>
  sync: Pick<WorkspaceSync, 'syncStatus' | 'hasUnsynced'>
  flushEvents: () => Promise<void>
}

export function useMediaOutbox({
  swapPhoto, swapAttachmentMedia, overlayRow, patchRow, incidentMeta, canWriteRecord, closedRefusedTotal,
  exportedClosedRefused, recordsSyncStatus, syncWorkspaceNow, journal, auditDelivery, sync,
  flushEvents,
}: UseMediaOutboxInputs) {
  // Offline media queue: reattaches queued captures to their rows after a reload, retries on
  // reconnect, and swaps a row's local blob: URL for the persistent server URL on success.
  const swapRowMedia = useCallback((rowId: string, kind: 'photo' | 'audio', url: string, replaces?: string, target?: MediaTarget) => {
    if (target === 'attachment') { swapAttachmentMedia(rowId, url); return }
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
  }, [swapPhoto, swapAttachmentMedia, overlayRow, patchRow])

  // `rowId url` of every link this session made — the rows of a render can lag the store
  const linked = useRef(new Set<string>())
  const { rows, getStatus: journalStatus, rowShown } = journal
  /** A receipt's replay (useMediaQueue · onUploaded): link once, retire once delivered. */
  const linkUploaded = useCallback((rowId: string, kind: 'photo' | 'audio', url: string, replaces?: string, target?: MediaTarget): boolean => {
    const key = `${target ?? 'row'} ${rowId} ${url}`
    if (target === 'attachment') {
      if (!linked.current.has(key)) {
        // committed now, with the workspace's save effect: a check after it sees that save
        flushSync(() => swapAttachmentMedia(rowId, url))
        linked.current.add(key)
      }
      return !sync.hasUnsynced
    }
    const shown = rowShown(rowId)
    // the Verlauf has not loaded: a photo patch now could hide pictures it cannot see — wait
    if (shown === undefined) return false
    // retracted (or no such row): nothing to link — retire once the Verlauf has delivered its work
    if (!shown) return journalStatus() === 'synced'
    const row = rows.find((r) => r.id === rowId)
    if (!row) return false // shown, but this render predates it: the next render replays
    const carried = kind === 'photo' ? rowPhotos(row).includes(url) : row.audioUrl === url
    if (!carried && !linked.current.has(key)) {
      swapRowMedia(rowId, kind, url, replaces)
      linked.current.add(key)
    }
    return journalStatus() === 'synced'
  }, [rows, journalStatus, rowShown, swapRowMedia, swapAttachmentMedia, sync])

  const media = useMediaQueue({
    incidentId: incidentMeta.id, readOnly: !canWriteRecord,
    onUploaded: linkUploaded, onRestore: swapRowMedia,
  })
  // Every change of the Verlauf may be the one a receipt waits for (its row loaded, its patch
  // delivered), and so may the records' status turning (a Beilage's workspace save landing).
  // The replay itself sends nothing, so this cannot spin.
  const { receiptCount, replayReceipts } = media
  useEffect(() => { if (receiptCount) void replayReceipts() }, [receiptCount, replayReceipts, rows, recordsSyncStatus])

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
    // what the flush just linked is in the Verlauf outbox: send it, then retire its receipts
    await journal.flush().catch(() => {})
    await media.replayReceipts().catch(() => {})
    if (combinedSyncStatus(sync.syncStatus, journal.getStatus(), auditDelivery.getStatus(), media.getStatus()) !== 'synced') {
      throw new Error('Operational records have not all been acknowledged')
    }
  }

  /** the closing device's own queue, drained before the archive PATCH (useAbschluss) — the
   *  receipts last, once their links have gone out with the Verlauf, so the archive does not
   *  keep them as «still queued» (mediaQueue · clearUploadedMedia) */
  const { flush: flushJournal } = journal
  const flushRecordOutboxes = useCallback(async () => {
    await Promise.all([flushJournal(), flushEvents()]).catch(() => {})
    await replayReceipts().catch(() => {})
  }, [flushJournal, flushEvents, replayReceipts])
  return { media, flushRecordOutboxes, swapRowMedia, syncStatus, closedRefusedUnexported, baseSyncStatus, syncNow }
}
