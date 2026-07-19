// React binding for the offline media upload queue (see mediaQueue.ts). It keeps the queued
// items in state, restores pending captures onto their timeline rows after a reload (the blob
// lives in IndexedDB; the row's session-only blob: URL was dropped on save), and re-drains the
// queue whenever connectivity returns so nothing sits un-uploaded once we're back online.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uploadMedia } from './incidents'
import {
  enqueueMedia,
  flushMediaQueue,
  listMediaQueue,
  sameQueue,
  type MediaQueueItem,
  type MediaStatus,
} from './mediaQueue'

interface Opts {
  incidentId: string
  readOnly: boolean
  /** an upload succeeded — swap the row's local URL for the persistent server URL */
  onUploaded: (rowId: string, kind: 'photo' | 'audio', url: string) => void
  /** a queued (not-yet-uploaded) capture was found — reattach it to its row for display */
  onRestore: (rowId: string, kind: 'photo' | 'audio', localUrl: string) => void
}

export interface MediaQueueApi {
  /** in-queue status for a timeline row, or undefined if the row's media is fully uploaded */
  statusOf: (rowId: string) => MediaStatus | undefined
  /** number of captures not yet on the server (pending + failed) */
  pendingCount: number
  /** persist a blob whose direct upload just failed, so it survives reload and retries */
  enqueue: (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string) => Promise<void>
  /** attempt to upload everything queued for this incident (best-effort, never throws) */
  flush: () => Promise<void>
}

export function useMediaQueue({ incidentId, readOnly, onUploaded, onRestore }: Opts): MediaQueueApi {
  const [items, setItems] = useState<MediaQueueItem[]>([])
  // keep callbacks in refs so the window/online listeners always call the fresh versions
  const cb = useRef({ onUploaded, onRestore })
  cb.current = { onUploaded, onRestore }
  // object URLs we minted for restored rows, so we can revoke them once uploaded/cleared
  const restoredUrls = useRef(new Map<string, string>())

  const refresh = useCallback(async () => {
    const next = await listMediaQueue(incidentId)
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
      cb.current.onUploaded(u.rowId, u.kind, u.url)
      const old = restoredUrls.current.get(u.id)
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
        cb.current.onRestore(item.rowId, item.kind, url)
      }
      setItems(q)
      void flush()
    })()
    return () => {
      alive = false
      for (const url of restoredUrls.current.values()) URL.revokeObjectURL(url)
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

  const enqueue = useCallback(async (rowId: string, kind: 'photo' | 'audio', blob: Blob, filename: string, createdAt: string) => {
    await enqueueMedia(incidentId, rowId, kind, blob, filename, createdAt)
    await refresh()
  }, [incidentId, refresh])

  const statusOf = useCallback((rowId: string): MediaStatus | undefined => {
    // a row can carry both photo and audio; surface the more urgent state
    const forRow = items.filter((i) => i.rowId === rowId)
    if (forRow.some((i) => i.status === 'failed')) return 'failed'
    return forRow.length ? 'pending' : undefined
  }, [items])

  // stable API object — consumers hang effects off `media`, and a fresh object per render
  // (the other half of the re-render loop above) re-fired them on every commit
  return useMemo(() => ({ statusOf, pendingCount: items.length, enqueue, flush }),
    [statusOf, items.length, enqueue, flush])
}
