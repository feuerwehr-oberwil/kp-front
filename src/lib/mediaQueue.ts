// Offline media upload queue. Photos/audio captured in the field are incident records, not
// session-only UI objects — append-only media records with an offline upload queue.
// When an upload can't complete — offline at the Einsatzort, or a transient server failure —
// the binary blob and its metadata are persisted in IndexedDB so a page reload doesn't lose
// the capture, and the upload is retried automatically when connectivity returns.
//
// Storage: one array per incident under an IDB key (mirrors the workspace-cache keying in
// incidents.ts), so draining or clearing an incident's pending media is a single read/write.
// Blobs ride in the entry directly — IndexedDB stores Blob natively via structured clone.
// NOTE: on the localStorage fallback path (idb.ts, when IndexedDB is unavailable — Safari
// private mode, locked-down WebViews) a Blob does NOT survive JSON serialization, so queuing
// degrades to session-only there — the same loss behaviour we had before this queue existed,
// never worse.

import { ApiError } from './api'
import { idbDel, idbGet, idbSet } from './idb'

const PREFIX = 'kp-front-mediaq-'
const keyFor = (incidentId: string) => `${PREFIX}${incidentId}`

/** `pending` = waiting for connectivity (never attempted, or the last attempt was offline);
 *  `failed` = the server rejected it repeatedly (a real error, not just no network). */
export type MediaStatus = 'pending' | 'failed'

export interface MediaQueueItem {
  id: string                     // queue id — one per (rowId, kind); a re-capture replaces it
  incidentId: string
  rowId: string                  // timeline event id the media hangs off
  kind: 'photo' | 'audio'
  blob: Blob
  filename: string
  createdAt: string              // ISO — when the capture was made
  attempts: number               // count of failed upload attempts (network drops don't count)
  status: MediaStatus
  lastError?: string
}

/** After this many server-side (non-network) failures an item is surfaced as `failed`
 *  rather than an ever-pending upload the operator can't reason about. */
const MAX_ATTEMPTS = 3

export const mediaQueueId = (rowId: string, kind: 'photo' | 'audio') => `${rowId}:${kind}`

/** Same queue content (id + status per slot)? Lets the React binding keep the PREVIOUS state
 *  identity when a re-list changed nothing — setItems(new array) on every flush was the state
 *  churn behind an App-wide re-render loop (~900 commits/s: render → flush effect → IDB →
 *  setItems → render), a measured phone battery/heat drain. */
export const sameQueue = (a: MediaQueueItem[], b: MediaQueueItem[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.status === b[i].status && x.attempts === b[i].attempts)

const navigatorOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true)

async function readQueue(incidentId: string): Promise<MediaQueueItem[]> {
  return (await idbGet<MediaQueueItem[]>(keyFor(incidentId))) ?? []
}
async function writeQueue(incidentId: string, items: MediaQueueItem[]): Promise<void> {
  if (items.length) await idbSet(keyFor(incidentId), items)
  else await idbDel(keyFor(incidentId))
}

/** Persist a captured blob for later upload, replacing any prior entry for the same row+kind
 *  (a re-capture supersedes the old one). Resets it to `pending` for a fresh retry cycle. */
export async function enqueueMedia(
  incidentId: string,
  rowId: string,
  kind: 'photo' | 'audio',
  blob: Blob,
  filename: string,
  createdAt: string,
): Promise<void> {
  const id = mediaQueueId(rowId, kind)
  const items = await readQueue(incidentId)
  const next = items.filter((i) => i.id !== id)
  next.push({ id, incidentId, rowId, kind, blob, filename, createdAt, attempts: 0, status: 'pending' })
  await writeQueue(incidentId, next)
}

export const listMediaQueue = (incidentId: string): Promise<MediaQueueItem[]> => readQueue(incidentId)

/** Drop the whole queue for an incident (called when an incident is archived/closed). */
export const clearIncidentMedia = (incidentId: string): Promise<void> => idbDel(keyFor(incidentId))

export type MediaUploader = (
  incidentId: string,
  blob: Blob,
  kind: 'photo' | 'audio',
  filename: string,
) => Promise<{ url: string }>

export interface FlushOutcome {
  uploaded: { id: string; rowId: string; kind: 'photo' | 'audio'; url: string }[]
  remaining: MediaQueueItem[]
}

/** Attempt every queued item for an incident. Successful uploads are removed and returned so
 *  the caller can swap the timeline row's local blob: URL for the server URL. A network drop
 *  leaves the item `pending` (attempts unchanged — it never got to the server); a real server
 *  error counts an attempt and flips to `failed` past MAX_ATTEMPTS. Never throws — a bad flush
 *  just leaves work queued for the next one. */
export async function flushMediaQueue(incidentId: string, upload: MediaUploader): Promise<FlushOutcome> {
  const items = await readQueue(incidentId)
  const uploaded: FlushOutcome['uploaded'] = []
  const remaining: MediaQueueItem[] = []
  for (const item of items) {
    try {
      const { url } = await upload(incidentId, item.blob, item.kind, item.filename)
      uploaded.push({ id: item.id, rowId: item.rowId, kind: item.kind, url })
    } catch (e) {
      // A network failure (offline / server unreachable) is not the item's fault — keep it
      // pending without burning an attempt. Only a reachable-but-rejecting server counts.
      const networkDown = !navigatorOnline() || (e instanceof ApiError && e.status === 0)
      const attempts = networkDown ? item.attempts : item.attempts + 1
      const status: MediaStatus = !networkDown && attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
      remaining.push({ ...item, attempts, status, lastError: e instanceof Error ? e.message : String(e) })
    }
  }
  await writeQueue(incidentId, remaining)
  return { uploaded, remaining }
}
