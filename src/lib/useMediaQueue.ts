// React binding for the offline media upload queue (see mediaQueue.ts). It keeps the queued
// items in state, restores pending captures onto their timeline rows after a reload (the blob
// lives in IndexedDB; the row's session-only blob: URL was dropped on save), and re-drains the
// queue whenever connectivity returns so nothing sits un-uploaded once we're back online.
// `target: 'attachment'` keeps Rapport-Beilagen on that same durable/retrying path, with their
// restore/upload callbacks routed to attachment ids rather than append-only journal rows.
// Uploads land as RECEIPTS (mediaQueue header): `replay` hands each to `onUploaded` after every
// flush, on start and whenever the caller asks (`replayReceipts`), and retires it once
// `onUploaded` says the link is acknowledged — never after this hook has unmounted, when the
// store it links into may already be gone. Receipts keep their `target` for that call.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uploadMedia } from './incidents'
import { forgetLocalThumb, mintLocalThumb } from './mediaUrl'
import {
  enqueueMedia,
  flushMediaQueue,
  isMediaQueueDurable,
  isReceipt,
  listMediaQueue,
  retireMediaReceipts,
  sameQueue,
  type MediaQueueItem,
  type MediaStatus,
  type MediaTarget,
} from './mediaQueue'
import type { SyncStatus } from './api/workspaceSync'

/**
 * The media queue's part of the shared sync status («Saved means every operational queue is
 * acknowledged», docs/sync-and-offline.md). A capture is not on the record until the server has it, so a queued
 * one is `pending`; one the server keeps refusing is `error`; one this device could not even
 * store is `storage` — the same three words the workspace, journal and audit outboxes use. A
 * receipt (uploaded, link not yet acknowledged) is `pending` too.
 */
export function mediaSyncStatus(items: MediaQueueItem[], durable: boolean): SyncStatus {
  if (!items.length) return 'synced'
  if (!durable) return 'storage'
  return items.some((i) => i.status === 'failed') ? 'error' : 'pending'
}

interface Opts {
  incidentId: string
  readOnly: boolean
  /** a receipt: the server has the bytes — link the row (or, with `target: 'attachment'`, the
   *  Beilage) to `url` (in place of `localUrl`: a row can carry several pictures, and the others
   *  must survive). Called again on every replay until it answers true («the link is
   *  acknowledged, retire the receipt»), across reloads too, so it MUST be idempotent: a link
   *  already made is not made twice. */
  onUploaded: (rowId: string, kind: 'photo' | 'audio', url: string, localUrl?: string, target?: MediaTarget) => boolean
  /** a queued (not-yet-uploaded) capture was found — reattach it to its row for display */
  onRestore: (rowId: string, kind: 'photo' | 'audio', localUrl: string, replaces?: string, target?: MediaTarget) => void
}

export interface MediaQueueApi {
  /** in-queue status for a timeline row, or undefined if the row's media is fully uploaded */
  statusOf: (rowId: string) => MediaStatus | undefined
  /** number of captures not yet on the server (pending + failed) — receipts are not counted */
  pendingCount: number
  /** uploads whose link is not acknowledged yet (receipts) */
  receiptCount: number
  /** hand every receipt to `onUploaded` again and retire the acknowledged ones */
  replayReceipts: () => Promise<void>
  /** persist a blob before upload (attachments), or after a direct upload failed (journal).
   *  Resolves false when it could only be held in memory (see mediaQueue · enqueueMedia). */
  enqueue: (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string, target?: MediaTarget) => Promise<boolean>
  /** attempt to upload everything queued for this incident (best-effort, never throws) */
  flush: (options?: { retry?: boolean }) => Promise<void>
  /** this queue's part of the shared sync status (mediaSyncStatus) */
  syncStatus: SyncStatus
  /** the same, current as of the last queue operation — for a caller that just awaited flush() */
  getStatus: () => SyncStatus
}

export function useMediaQueue({ incidentId, readOnly, onUploaded, onRestore }: Opts): MediaQueueApi {
  const [items, setItems] = useState<MediaQueueItem[]>([])
  const [durable, setDurable] = useState(true)
  const [reconnected, setReconnected] = useState(0)
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

  // mounted? A replay after unmount would link into a disposed store, which drops the
  // link without a word — and then retire the receipt. Declared before the mount effect below.
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // Hand every receipt to its row (or Beilage) and retire the ones whose link is acknowledged.
  const replay = useCallback(async () => {
    if (readOnly || !mounted.current) return
    const receipts = (await listMediaQueue(incidentId)).filter(isReceipt)
    if (!mounted.current) return
    // after a reload the row shows the object URL we minted at restore, not the one the
    // capture was queued with — that is the picture the server URL has to replace
    const done = receipts.filter((r) => cb.current.onUploaded(r.rowId, r.kind, r.url, restoredUrls.current.get(r.id) ?? r.localUrl, r.target))
    if (!done.length) return
    await retireMediaReceipts(incidentId, done)
    for (const r of done) {
      // linked for good: its session thumbnail (restored OR minted at the capture) and the
      // restored object URL have nothing left to show
      const old = restoredUrls.current.get(r.id)
      const local = old ?? r.localUrl
      if (local) forgetLocalThumb(local)
      if (old) { URL.revokeObjectURL(old); restoredUrls.current.delete(r.id) }
    }
  }, [incidentId, readOnly])

  const flush = useCallback(async (options?: { retry?: boolean }) => {
    if (readOnly) return
    await flushMediaQueue(incidentId, uploadMedia, options)
    await replay()
    await refresh()
  }, [incidentId, readOnly, refresh, replay])

  const replayReceipts = useCallback(async () => {
    await replay()
    await refresh()
  }, [replay, refresh])

  // On mount / incident switch: reattach any queued captures to their rows, then try to drain.
  useEffect(() => {
    let alive = true
    void (async () => {
      const q = await listMediaQueue(incidentId)
      if (!alive) return
      for (const item of q) {
        // a receipt has no bytes left to show — the replay links its server copy instead
        if (isReceipt(item)) continue
        if (!(item.blob instanceof Blob)) continue // retain corrupt legacy metadata, without throwing on restore
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
        cb.current.onRestore(item.rowId, item.kind, url, item.localUrl, item.target)
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
    const onOnline = () => { setReconnected((n) => n + 1); void flush() }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flush])

  // Retry only pending captures, at their persisted deadline. Updating attempts must never
  // cause an immediate render → upload → render loop; permanently failed items need a tap.
  useEffect(() => {
    if (readOnly || !navigator.onLine) return
    const pending = items.filter((item) => item.status === 'pending')
    if (!pending.length) return
    const at = Math.min(...pending.map((item) => item.retryAt ?? 0))
    const timer = setTimeout(() => { void flush() }, Math.max(0, at - Date.now()))
    return () => clearTimeout(timer)
  }, [items, flush, readOnly, reconnected])

  const enqueue = useCallback(async (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string, target?: MediaTarget) => {
    const stored = await enqueueMedia(incidentId, rowId, kind, blob, filename, createdAt, localUrl, target)
    await refresh()
    return stored
  }, [incidentId, refresh])

  const statusOf = useCallback((rowId: string): MediaStatus | undefined => {
    // a row can carry both photo and audio; surface the more urgent state. A receipt is
    // uploaded — nothing for the row to wait for.
    const forRow = items.filter((i) => i.rowId === rowId && !isReceipt(i))
    if (forRow.some((i) => i.status === 'failed')) return 'failed'
    return forRow.length ? 'pending' : undefined
  }, [items])
  const receiptCount = items.filter(isReceipt).length
  const pendingCount = items.length - receiptCount

  // stable API object — consumers hang effects off `media`, and a fresh object per render
  // (the other half of the re-render loop above) re-fired them on every commit
  // A read-only tab uploads nothing and re-lists nothing: the tab that owns the incident reports
  // the queue, and a watcher repeating its stale copy would only contradict it.
  const syncStatus: SyncStatus = readOnly ? 'synced' : mediaSyncStatus(items, durable)
  const getStatus = useCallback((): SyncStatus => (readOnly ? 'synced' : status.current), [readOnly])
  return useMemo(() => ({ statusOf, pendingCount, receiptCount, replayReceipts, enqueue, flush, syncStatus, getStatus }),
    [statusOf, pendingCount, receiptCount, replayReceipts, enqueue, flush, syncStatus, getStatus])
}
