// React binding for the offline media upload queue (see mediaQueue.ts). It keeps the queued
// items in state, restores pending captures onto their timeline rows after a reload (the blob
// lives in IndexedDB; the row's session-only blob: URL was dropped on save), and re-drains the
// queue whenever connectivity returns so nothing sits un-uploaded once we're back online.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uploadMedia } from './incidents'
import { forgetLocalThumb, mintLocalThumb } from './mediaUrl'
import {
  enqueueMedia,
  flushMediaQueue,
  isMediaQueueDurable,
  listMediaQueue,
  sameQueue,
  type MediaQueueItem,
  type MediaStatus,
} from './mediaQueue'
import type { SyncStatus } from './api/workspaceSync'

/**
 * The media queue's part of the shared sync status («Saved means every operational queue is
 * acknowledged», AGENTS.md). A capture is not on the record until the server has it, so a queued
 * one is `pending`; one the server keeps refusing is `error`; one this device could not even
 * store is `storage` — the same three words the workspace, journal and audit outboxes use.
 */
export function mediaSyncStatus(items: MediaQueueItem[], durable: boolean): SyncStatus {
  if (!items.length) return 'synced'
  if (!durable) return 'storage'
  return items.some((i) => i.status === 'failed') ? 'error' : 'pending'
}

interface Opts {
  incidentId: string
  readOnly: boolean
  /** an upload succeeded — swap the row's local URL for the persistent server URL. `localUrl`
   *  names WHICH picture settled: a row can carry several, and the others must survive. */
  onUploaded: (rowId: string, kind: 'photo' | 'audio', url: string, localUrl?: string) => void
  /** a queued (not-yet-uploaded) capture was found — reattach it to its row for display */
  onRestore: (rowId: string, kind: 'photo' | 'audio', localUrl: string, replaces?: string) => void
}

export interface MediaQueueApi {
  /** in-queue status for a timeline row, or undefined if the row's media is fully uploaded */
  statusOf: (rowId: string) => MediaStatus | undefined
  /** number of captures not yet on the server (pending + failed) */
  pendingCount: number
  /** persist a blob whose direct upload just failed, so it survives reload and retries.
   *  Resolves false when it could only be held in memory (see mediaQueue · enqueueMedia). */
  enqueue: (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string) => Promise<boolean>
  /** attempt to upload everything queued for this incident (best-effort, never throws) */
  flush: () => Promise<void>
  /** this queue's part of the shared sync status (mediaSyncStatus) */
  syncStatus: SyncStatus
  /** the same, current as of the last queue operation — for a caller that just awaited flush() */
  getStatus: () => SyncStatus
}

export function useMediaQueue({ incidentId, readOnly, onUploaded, onRestore }: Opts): MediaQueueApi {
  const [items, setItems] = useState<MediaQueueItem[]>([])
  const [durable, setDurable] = useState(true)
  const status = useRef<SyncStatus>('synced')
  // keep callbacks in refs so the window/online listeners always call the fresh versions
  const cb = useRef({ onUploaded, onRestore })
  cb.current = { onUploaded, onRestore }
  // object URLs we minted for restored rows, so we can revoke them once uploaded/cleared
  const restoredUrls = useRef(new Map<string, string>())

  const refresh = useCallback(async () => {
    const next = await listMediaQueue(incidentId)
    const stored = isMediaQueueDurable(incidentId)
    status.current = mediaSyncStatus(next, stored)
    setDurable(stored)
    // IDENTITY-PRESERVING when nothing changed (the common case: empty queue, no uploads).
    // setItems(fresh array) unconditionally was one half of an App-wide re-render loop:
    // render → flush effect (unstable `media` dep) → IDB roundtrips → setItems(new []) →
    // render → … at ~900 commits/s — the "phone gets hot" battery drain. With a stable
    // identity React bails out and the loop settles.
    setItems((prev) => (sameQueue(prev, next) ? prev : next))
  }, [incidentId])

  const flush = useCallback(async () => {
    if (readOnly) return
    const { uploaded } = await flushMediaQueue(incidentId, uploadMedia)
    for (const u of uploaded) {
      // after a reload the row shows the object URL we minted at restore, not the one the
      // capture was queued with — that is the picture the server URL has to replace
      const old = restoredUrls.current.get(u.id)
      cb.current.onUploaded(u.rowId, u.kind, u.url, old ?? u.localUrl)
      // the picture is on the server now: its session thumbnail (restored OR minted at the
      // capture) and the restored object URL have nothing left to show
      const local = old ?? u.localUrl
      if (local) forgetLocalThumb(local)
      if (old) { URL.revokeObjectURL(old); restoredUrls.current.delete(u.id) }
    }
    await refresh()
  }, [incidentId, readOnly, refresh])

  // On mount / incident switch: reattach any queued captures to their rows, then try to drain.
  useEffect(() => {
    let alive = true
    void (async () => {
      const q = await listMediaQueue(incidentId)
      if (!alive) return
      for (const item of q) {
        const url = URL.createObjectURL(item.blob)
        restoredUrls.current.set(item.id, url)
        // ⚠️ The chip reads a session THUMBNAIL of the queued file (lib/mediaUrl); the full
        // object URL is only for the viewer. Minted before the row shows it, one picture at a
        // time: every pending photo re-minted at full size on every launch is what killed the
        // tab of an offline phone, again on each reopen for as long as it stayed offline.
        if (item.kind === 'photo') await mintLocalThumb(url, item.blob)
        if (!alive) { forgetLocalThumb(url); URL.revokeObjectURL(url); return }
        // the queued-with URL died with the previous session; hand it over so the restore
        // replaces that dead entry instead of appending a duplicate picture to the row
        cb.current.onRestore(item.rowId, item.kind, url, item.localUrl)
      }
      status.current = mediaSyncStatus(q, isMediaQueueDurable(incidentId))
      setDurable(isMediaQueueDurable(incidentId))
      setItems(q)
      void flush()
    })()
    return () => {
      alive = false
      for (const url of restoredUrls.current.values()) { forgetLocalThumb(url); URL.revokeObjectURL(url) }
      restoredUrls.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId])

  // Retry the moment the browser reports connectivity is back.
  useEffect(() => {
    const onOnline = () => void flush()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flush])

  const enqueue = useCallback(async (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string) => {
    const stored = await enqueueMedia(incidentId, rowId, kind, blob, filename, createdAt, localUrl)
    await refresh()
    return stored
  }, [incidentId, refresh])

  const statusOf = useCallback((rowId: string): MediaStatus | undefined => {
    // a row can carry both photo and audio; surface the more urgent state
    const forRow = items.filter((i) => i.rowId === rowId)
    if (forRow.some((i) => i.status === 'failed')) return 'failed'
    return forRow.length ? 'pending' : undefined
  }, [items])

  // stable API object — consumers hang effects off `media`, and a fresh object per render
  // (the other half of the re-render loop above) re-fired them on every commit
  // A read-only tab uploads nothing and re-lists nothing: the tab that owns the incident reports
  // the queue, and a watcher repeating its stale copy would only contradict it.
  const syncStatus: SyncStatus = readOnly ? 'synced' : mediaSyncStatus(items, durable)
  const getStatus = useCallback((): SyncStatus => (readOnly ? 'synced' : status.current), [readOnly])
  return useMemo(() => ({ statusOf, pendingCount: items.length, enqueue, flush, syncStatus, getStatus }),
    [statusOf, items.length, enqueue, flush, syncStatus, getStatus])
}
