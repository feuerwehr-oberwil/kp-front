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
import { withTileEviction } from './tileEvict'

const PREFIX = 'kp-front-mediaq-'
const keyFor = (incidentId: string) => `${PREFIX}${incidentId}`

/** `pending` = waiting for connectivity (never attempted, or the last attempt was offline);
 *  `failed` = the server rejected it repeatedly (a real error, not just no network). */
export type MediaStatus = 'pending' | 'failed'

export interface MediaQueueItem {
  id: string                     // queue id — see mediaQueueId
  incidentId: string
  rowId: string                  // timeline event id the media hangs off
  kind: 'photo' | 'audio'
  blob: Blob
  filename: string
  createdAt: string              // ISO — when the capture was made
  attempts: number               // count of failed upload attempts (network drops don't count)
  status: MediaStatus
  lastError?: string
  /** the row's blob: URL this capture stands for — the picture the server URL replaces once
   *  it uploads. Absent on audio (a row has one voice memo) and on pre-2026-08 queue entries. */
  localUrl?: string
}

/** After this many server-side (non-network) failures an item is surfaced as `failed`
 *  rather than an ever-pending upload the operator can't reason about. */
const MAX_ATTEMPTS = 3

/** Queue id. Audio is one per row — a re-recorded voice memo supersedes the old one. Photos are
 *  a LIST, so they key on the individual picture: keying them per row made each queued photo
 *  evict the previous one, and three photos taken offline left two of them destroyed. */
export const mediaQueueId = (rowId: string, kind: 'photo' | 'audio', localUrl?: string) =>
  kind === 'photo' && localUrl ? `${rowId}:photo:${localUrl}` : `${rowId}:${kind}`

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
/** Returns whether the queue is durably stored. A queued photo/voice memo is an incident record
 *  that exists ONLY here until it uploads, so a full device evicts map tiles to make room rather
 *  than dropping it — scenery is re-downloadable, the capture is not. */
async function writeQueue(incidentId: string, items: MediaQueueItem[]): Promise<boolean> {
  if (!items.length) { await idbDel(keyFor(incidentId)); return true }
  return withTileEviction(() => idbSet(keyFor(incidentId), items))
}

/** Persist a captured blob for later upload, replacing any prior entry with the same queue id
 *  (a re-recorded voice memo supersedes the old one; photos key per picture, so they stack).
 *  Resets it to `pending` for a fresh retry cycle. */
export async function enqueueMedia(
  incidentId: string,
  rowId: string,
  kind: 'photo' | 'audio',
  blob: Blob,
  filename: string,
  createdAt: string,
  localUrl?: string,
): Promise<void> {
  const id = mediaQueueId(rowId, kind, localUrl)
  const items = await readQueue(incidentId)
  const next = items.filter((i) => i.id !== id)
  next.push({ id, incidentId, rowId, kind, blob, filename, createdAt, attempts: 0, status: 'pending', ...(localUrl ? { localUrl } : {}) })
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
  uploaded: { id: string; rowId: string; kind: 'photo' | 'audio'; url: string; localUrl?: string }[]
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
      uploaded.push({ id: item.id, rowId: item.rowId, kind: item.kind, url, localUrl: item.localUrl })
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
