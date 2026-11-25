// React binding for the offline media upload queue (see mediaQueue.ts). It keeps the queued
// items in state, restores pending captures onto their timeline rows after a reload (the blob
// lives in IndexedDB; the row's session-only blob: URL was dropped on save), and re-drains the
// queue whenever connectivity returns (the `online` event, or the server answering again –
// connectivity · onReachable) so nothing sits out a dead link's backoff once we're back online.
// `target: 'attachment'` keeps Rapport-Beilagen on that same durable/retrying path, with their
// restore/upload callbacks routed to attachment ids rather than append-only journal rows.
// Uploads land as RECEIPTS (mediaQueue header): `replay` hands each to `onUploaded` after every
// flush, on start and whenever the caller asks (`replayReceipts`), and retires it once
// `onUploaded` says the link is acknowledged — never after this hook has unmounted, when the
// store it links into may already be gone. Receipts keep their `target` for that call.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onReachable } from './connectivity'
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
  type MediaReceipt,
  type MediaStatus,
  type MediaTarget,
} from './mediaQueue'
import type { SyncStatus } from './api/workspaceSync'
import type { PhotoSlot } from './verlauf'

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

/** The queue with each row's pictures in their captured order (mediaQueue · slot), rows in the
 *  order they first appear. Working a row in this order is what makes `placeOf` exact. */
function inSlotOrder<T extends MediaQueueItem>(items: readonly T[]): T[] {
  const firstOfRow = new Map<string, number>()
  items.forEach((item, i) => { if (!firstOfRow.has(item.rowId)) firstOfRow.set(item.rowId, i) })
  return [...items].sort((a, b) => (firstOfRow.get(a.rowId) ?? 0) - (firstOfRow.get(b.rowId) ?? 0) || (a.slot ?? 0) - (b.slot ?? 0))
}

/** Where `item` goes back into its row (verlauf · PhotoSlot): its captured slot, and the server
 *  URLs of the row's lower-slot receipts in `queue` — linked after it or not yet, so they may be
 *  missing from the list it is placed into. Undefined for an entry without a slot. */
function placeOf(item: MediaQueueItem, queue: readonly MediaQueueItem[]): PhotoSlot | undefined {
  const { slot } = item
  if (slot == null) return undefined
  const ahead = queue
    .filter((q): q is MediaReceipt => isReceipt(q) && q.rowId === item.rowId && q.slot != null && q.slot < slot)
    .map((q) => q.url)
  return { slot, ahead }
}

interface Opts {
  incidentId: string
  readOnly: boolean
  /** Asked at the moment of linking and of retiring, not per render: does this tab still hold
   *  the Einsatz's edit lock (api/workspaceSync · canWrite)? A tab that lost it to another one
   *  re-renders read-only only later; a replay still running in it would link into a view that
   *  saves nothing and retire the receipt the new holder needs. Omitted → `!readOnly`. */
  writable?: () => boolean
  /** a receipt: the server has the bytes — link the row (or, with `target: 'attachment'`, the
   *  Beilage) to `url` (in place of `localUrl`: a row can carry several pictures, and the others
   *  must survive). Called again on every replay until it answers true («the link is
   *  acknowledged, retire the receipt»), across reloads too, so it MUST be idempotent: a link
   *  already made is not made twice. */
  onUploaded: (rowId: string, kind: 'photo' | 'audio', url: string, localUrl?: string, target?: MediaTarget, place?: PhotoSlot) => boolean
  /** a queued (not-yet-uploaded) capture was found — reattach it to its row for display, at
   *  `place` (verlauf · swapUrl) when its old URL is gone */
  onRestore: (rowId: string, kind: 'photo' | 'audio', localUrl: string, replaces?: string, target?: MediaTarget, place?: PhotoSlot) => void
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
  /** persist a capture before its upload (journal media and Beilagen alike).
   *  Resolves false when it could only be held in memory (see mediaQueue · enqueueMedia). */
  enqueue: (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string, target?: MediaTarget, uploadId?: string, slot?: number) => Promise<boolean>
  /** attempt to upload everything queued for this incident (best-effort, never throws) */
  flush: (options?: { retry?: boolean }) => Promise<void>
  /** this queue's part of the shared sync status (mediaSyncStatus) */
  syncStatus: SyncStatus
  /** the same, current as of the last queue operation — for a caller that just awaited flush() */
  getStatus: () => SyncStatus
}

export function useMediaQueue({ incidentId, readOnly, writable, onUploaded, onRestore }: Opts): MediaQueueApi {
  const [items, setItems] = useState<MediaQueueItem[]>([])
  const [durable, setDurable] = useState(true)
  const [reconnected, setReconnected] = useState(0)
  /** when a recovery signal held back by the early-try spacing gets its try (FlushOutcome · deferredUntil) */
  const [earlyAt, setEarlyAt] = useState<number>()
  const status = useRef<SyncStatus>('synced')
  // keep callbacks in refs so the window/online listeners always call the fresh versions
  const cb = useRef({ onUploaded, onRestore, writable })
  cb.current = { onUploaded, onRestore, writable }
  const mayWrite = useCallback(() => !readOnly && (cb.current.writable?.() ?? true), [readOnly])
  // object URLs we minted for restored rows, so we can revoke them once uploaded/cleared
  const restoredUrls = useRef(new Map<string, string>())
  /** which capture (mediaQueue · rev) each restored URL shows – a re-recorded memo keeps its id */
  const restoredRevs = useRef(new Map<string, string | undefined>())

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

  // A replay waits for the start-up restore to put every queued capture back on its row: a
  // receipt placed first would miss a lower slot that is still coming back (verlauf · swapUrl).
  const restored = useRef<Promise<void>>(Promise.resolve())

  // Hand every receipt to its row (or Beilage) and retire the ones whose link is acknowledged.
  const replay = useCallback(async () => {
    if (!mayWrite() || !mounted.current) return
    await restored.current
    if (!mounted.current) return
    const receipts = inSlotOrder((await listMediaQueue(incidentId)).filter(isReceipt))
    if (!mounted.current || !mayWrite()) return
    // after a reload the row shows the object URL we minted at restore, not the one the
    // capture was queued with — that is the picture the server URL has to replace
    const done = receipts.filter((r) => cb.current.onUploaded(r.rowId, r.kind, r.url, restoredUrls.current.get(r.id) ?? r.localUrl, r.target, placeOf(r, receipts)))
    if (!done.length) return
    // …asked again under the queue's lock: the edit lock may have gone while the links were made
    await retireMediaReceipts(incidentId, done, mayWrite)
    for (const r of done) {
      // linked for good: its session thumbnail (restored OR minted at the capture) and the
      // restored object URL have nothing left to show
      const old = restoredUrls.current.get(r.id)
      const local = old ?? r.localUrl
      if (local) forgetLocalThumb(local)
      if (old) { URL.revokeObjectURL(old); restoredUrls.current.delete(r.id); restoredRevs.current.delete(r.id) }
    }
  }, [incidentId, mayWrite])

  /** One pass over the queue. `hold`: a recovery signal that the early-try spacing held back
   *  arms its one later try (earlyAt). That later try runs with `hold` off: taken as a fresh
   *  signal it would arm the next one, and two waiting captures would hand each other a try a
   *  minute for ever on a link that answers nothing. */
  const run = useCallback(async (options: { retry?: boolean; due?: 'online' | 'reachable' } | undefined, hold: boolean) => {
    if (!mayWrite()) return
    const { deferredUntil } = await flushMediaQueue(incidentId, uploadMedia, options)
    if (hold && deferredUntil != null) setEarlyAt(deferredUntil)
    await replay()
    await refresh()
  }, [incidentId, mayWrite, refresh, replay])
  const flush = useCallback((options?: { retry?: boolean; due?: 'online' | 'reachable' }) => run(options, true), [run])

  const replayReceipts = useCallback(async () => {
    await replay()
    await refresh()
  }, [replay, refresh])

  /** Put each queued capture back on its row (or Beilage), a row's pictures in their captured
   *  order, each at exactly its own place (placeOf). `again`: the edit lock came to this tab and
   *  its workspace was replaced by the slot's – a Beilage is pointed at this page's object URL
   *  once more (by id: no duplicate), a row only at a capture this page has not restored yet
   *  (one the previous holder queued later). Resolves false when `alive` ended it. */
  const reattach = useCallback(async (q: MediaQueueItem[], alive: () => boolean, again = false): Promise<boolean> => {
    for (const item of inSlotOrder(q)) {
      // a receipt has no bytes left to show — the replay links its server copy instead
      if (isReceipt(item)) continue
      if (!(item.blob instanceof Blob)) continue // retain corrupt legacy metadata, without throwing on restore
      const shown = restoredUrls.current.get(item.id)
      // the same capture as this page restored – else a newer one under the id (Sol r3)
      const had = shown && restoredRevs.current.get(item.id) === item.rev ? shown : undefined
      if (had && (!again || item.target !== 'attachment')) continue
      const url = had ?? URL.createObjectURL(item.blob)
      if (!had) {
        restoredUrls.current.set(item.id, url)
        restoredRevs.current.set(item.id, item.rev)
        // ⚠️ The chip reads a session THUMBNAIL of the queued file (lib/mediaUrl); the full
        // object URL is only for the viewer. Minted before the row shows it, one picture at a
        // time: every pending photo re-minted at full size on every launch is what killed the
        // tab of an offline phone, again on each reopen for as long as it stayed offline.
        if (item.kind === 'photo') await mintLocalThumb(url, item.blob)
        if (!alive()) {
          for (const u of shown ? [url, shown] : [url]) { forgetLocalThumb(u); URL.revokeObjectURL(u) }
          restoredUrls.current.delete(item.id)
          restoredRevs.current.delete(item.id)
          return false
        }
      }
      // the queued-with URL died with the previous session; hand it over so the restore
      // replaces that dead entry instead of appending a duplicate picture to the row – or the
      // older capture this page showed under the id
      cb.current.onRestore(item.rowId, item.kind, url, shown && !had ? shown : item.localUrl, item.target, placeOf(item, q))
      if (shown && !had) { forgetLocalThumb(shown); URL.revokeObjectURL(shown) }
    }
    return true
  }, [])

  // On mount / incident switch: reattach any queued captures to their rows, then try to drain.
  useEffect(() => {
    let alive = true
    let done = () => {}
    // the maps are never replaced, only emptied: the cleanup below empties these same ones
    const urls = restoredUrls.current
    const revs = restoredRevs.current
    restored.current = new Promise<void>((resolve) => { done = resolve })
    void (async () => {
      const q = await listMediaQueue(incidentId)
      if (!alive || !(await reattach(q, () => alive))) { done(); return }
      done()
      status.current = mediaSyncStatus(q, isMediaQueueDurable(incidentId))
      setDurable(isMediaQueueDurable(incidentId))
      setItems(q)
      void flush()
    })().catch(() => done()) // a restore that failed must not hold every later replay
    return () => {
      alive = false
      for (const url of urls.values()) { forgetLocalThumb(url); URL.revokeObjectURL(url) }
      urls.clear()
      revs.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per Einsatz: the restore must not re-run per render
  }, [incidentId])

  // The edit lock came to this tab (read-only → writable): the queue as the previous holder left
  // it – this tab's last look may predate its captures and receipts – goes back on the rows of
  // the workspace this tab was just handed, then is sent and replayed.
  const wasReadOnly = useRef(readOnly)
  useEffect(() => {
    const promoted = wasReadOnly.current && !readOnly
    wasReadOnly.current = readOnly
    if (!promoted) return
    const after = restored.current
    restored.current = after
      .then(() => listMediaQueue(incidentId))
      .then((q) => reattach(q, () => mounted.current, true))
      .then(() => {}, () => {})
    void restored.current.then(() => flush())
  }, [readOnly, flush, incidentId, reattach])

  // Retry the moment connectivity is back – the browser's `online` event, or the server answering
  // again after a dead link (which the browser never announces). The pauses that dead link grew
  // are over: every waiting capture is due (mediaQueue · flushMediaQueue `due`).
  useEffect(() => {
    const onOnline = () => { setReconnected((n) => n + 1); void flush({ due: 'online' }) }
    window.addEventListener('online', onOnline)
    const offReachable = onReachable(() => { void flush({ due: 'reachable' }) })
    return () => { window.removeEventListener('online', onOnline); offReachable() }
  }, [flush])

  // A recovery signal that came while a capture's last early try was too recent: try it once
  // the spacing is over (its stored pause, if shorter, has its own timer below). Once per
  // signal – this try arms no further one (run · hold).
  useEffect(() => {
    if (earlyAt == null) return
    const timer = setTimeout(() => { setEarlyAt(undefined); void run({ due: 'reachable' }, false) }, Math.max(0, earlyAt - Date.now()))
    return () => clearTimeout(timer)
  }, [earlyAt, run])

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

  const enqueue = useCallback(async (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string, localUrl?: string, target?: MediaTarget, uploadId?: string, slot?: number) => {
    const stored = await enqueueMedia(incidentId, rowId, kind, blob, filename, createdAt, localUrl, target, uploadId, slot)
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
