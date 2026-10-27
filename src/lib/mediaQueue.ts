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
// keeps the original Blob in RAM and reports a storage failure. Never claim local durability
// for JSON metadata whose binary data would be lost on reload.
//
// ⚠️ Every read-modify-write of an incident's queue runs through ONE lane (lib/serialQueue,
// 23.09.2026). The queue is a single IDB value, so two writers that each read it, change it and
// write it back lose whichever wrote first — and there are always two: a composer row with three
// photos fires three uploads at once (each enqueues on failure), and a flush held its snapshot
// across every awaited upload and then wrote «what I had minus what went up» over anything
// captured in the meantime. The uploads themselves stay OUTSIDE the lane (a capture must never
// wait behind a slow upload to be stored); the flush re-reads the queue in the lane before it
// writes, and touches only the entries it actually attempted.
// Rapport-Beilagen use `target: 'attachment'` and their attachment id as `rowId`; an absent
// target remains a journal row, including every queue entry stored by older builds.
//
// ⚠️ An upload that lands leaves a RECEIPT, never a gap (audit F06, 26.10.2026). An entry runs
// capture (`pending`/`failed`, bytes aboard) → receipt (`uploaded`: the server URL, the bytes
// dropped) → retired. The flush used to delete the entry in the same write that settled the
// upload and only then hand the URL to the Verlauf — so a tab killed in between left the bytes
// on the server and the row unlinked for good. Now the flush writes the receipt; the React
// binding (useMediaQueue · replay) hands every receipt to the Verlauf, after each flush and on
// the next start, and retires it (`retireMediaReceipts`) only once the caller says the link is
// acknowledged. Linking must therefore be idempotent. A receipt is «not saved yet» for the sync
// status, but not a capture «not uploaded» (useMediaQueue · pendingCount). Entries stored
// before the receipt carry no `url` and are captures, as ever. A response lost on the way back
// still uploads the bytes twice (no idempotent upload by capture id on the server) — but only
// one of them is linked. A receipt keeps its `target`: an attachment's link goes to the Rapport,
// never to a Verlauf patch (useMediaOutbox).

import { isUnverifiable } from './api'
import { idbDel, idbRead, idbSet } from './idb'
import { newId } from './ids'
import { serialQueue } from './serialQueue'
import { withTileEviction } from './tileEvict'

const PREFIX = 'kp-front-mediaq-'
const keyFor = (incidentId: string) => `${PREFIX}${incidentId}`

/** A capture's state: `pending` = waiting for connectivity (never attempted, or the last attempt
 *  was offline); `failed` = the server rejected it repeatedly (a real error, not just no network). */
export type MediaStatus = 'pending' | 'failed'
export type MediaTarget = 'attachment'

interface MediaQueueEntry {
  id: string                     // queue id — see mediaQueueId
  incidentId: string
  rowId: string                  // timeline event id the media hangs off
  kind: 'photo' | 'audio'
  filename: string
  createdAt: string              // ISO — when the capture was made
  attempts: number               // count of failed upload attempts (network drops don't count)
  lastError?: string
  /** Earliest automatic retry. Failed items wait for the operator instead. */
  retryAt?: number
  /** the row's blob: URL this capture stands for — the picture the server URL replaces once
   *  it uploads. Absent on audio (a row has one voice memo) and on pre-2026-08 queue entries. */
  localUrl?: string
  /** which CAPTURE this entry is — minted per enqueue. The queue id alone cannot say it: a
   *  re-recorded voice memo reuses its row's id, and a flush that uploaded the old recording
   *  must not drop the new one queued behind it. Absent on entries queued before 23.09.2026. */
  rev?: string
  /** Absent for journal media; Rapport-Beilagen restore/swap only the attachment with rowId. */
  target?: MediaTarget
}
/** Still to upload: the bytes ride along. Every entry stored before 26.10.2026 is one. */
export interface MediaCapture extends MediaQueueEntry { status: MediaStatus; blob: Blob }
/** Uploaded, link owed: the server has the bytes under `url`, its row (or Beilage) may not know yet
 *  (see the header). Retired by `retireMediaReceipts`. */
export interface MediaReceipt extends MediaQueueEntry { status: 'uploaded'; url: string }
export type MediaQueueItem = MediaCapture | MediaReceipt

export const isReceipt = (item: MediaQueueItem): item is MediaReceipt => item.status === 'uploaded'

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
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.status === b[i].status && x.attempts === b[i].attempts && x.retryAt === b[i].retryAt)

/** Per incident: `edit` serialises every read-modify-write of the stored queue; `flush` keeps two
 *  flushes from uploading the same item twice (the `online` event and the sync recovering
 *  routinely fire together). Two lanes, so a capture is stored while a flush is uploading. */
const lanes = new Map<string, { edit: ReturnType<typeof serialQueue>; flush: ReturnType<typeof serialQueue> }>()
function laneFor(incidentId: string) {
  let lane = lanes.get(incidentId)
  if (!lane) { lane = { edit: serialQueue(), flush: serialQueue() }; lanes.set(incidentId, lane) }
  return lane
}

/** The same capture (not just the same slot): a flush settles an entry only while it is still
 *  the one it attempted. */
const sameCapture = (a: MediaQueueItem, b: MediaQueueItem) =>
  a.id === b.id && a.rev === b.rev && a.createdAt === b.createdAt

const navigatorOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true)

/** Captures this device holds but could NOT store — kept in page memory so they still upload,
 *  still count, and are written the moment a later queue operation's write lands.
 *  ⚠️ A failed write used to be ignored (23.09.2026): the capture was reported queued, existed
 *  only in the dying tab, and the sync status said «gespeichert». `known` says whether `items` is
 *  the WHOLE queue (a write failed after a good read) or only what was added while the stored
 *  queue could not even be read — which must then never be written over (lib/idb · idbRead). */
const unstored = new Map<string, { items: MediaQueueItem[]; known: boolean }>()

/** The queue as it stands: stored, plus whatever is held in memory. `known: false` = the store
 *  could not be read, so `items` is only the part this page holds. */
async function readQueue(incidentId: string): Promise<{ items: MediaQueueItem[]; known: boolean }> {
  const held = unstored.get(incidentId)
  const read = await idbRead<MediaQueueItem[]>(keyFor(incidentId))
  if (!read.ok) return held ?? { items: [], known: false }
  const stored = read.value ?? []
  if (!held) return { items: stored, known: true }
  if (held.known) return held // the newer whole queue whose write failed
  const heldIds = new Set(held.items.map((i) => i.id))
  return { items: [...stored.filter((i) => !heldIds.has(i.id)), ...held.items], known: true }
}
/** Returns whether the queue is durably stored. A queued photo/voice memo is an incident record
 *  that exists ONLY here until it uploads, so a full device evicts map tiles to make room rather
 *  than dropping it — scenery is re-downloadable, the capture is not. */
async function writeQueue(incidentId: string, items: MediaQueueItem[]): Promise<boolean> {
  if (!items.length) { await idbDel(keyFor(incidentId)); return true }
  return withTileEviction(() => idbSet(keyFor(incidentId), items))
}
/** Store the queue, or hold it in memory when that is not possible. Returns durability. */
async function storeQueue(incidentId: string, items: MediaQueueItem[], known: boolean): Promise<boolean> {
  if (!known) {
    // never write over a queue that could not be read; what this page holds waits in memory
    if (!items.length) { unstored.delete(incidentId); return true }
    unstored.set(incidentId, { items, known: false })
    return false
  }
  const ok = await writeQueue(incidentId, items)
  if (ok) unstored.delete(incidentId)
  else unstored.set(incidentId, { items, known: true })
  return ok
}

/** Is everything queued for this incident durably stored on the device? False while a capture
 *  lives only in page memory (a refused write, or a queue that could not be read). */
export const isMediaQueueDurable = (incidentId: string): boolean => !unstored.has(incidentId)

/** Persist a captured blob for later upload, replacing any prior entry with the same queue id
 *  (a re-recorded voice memo supersedes the old one; photos key per picture, so they stack).
 *  Resets it to `pending` for a fresh retry cycle. Resolves whether the capture is DURABLY
 *  queued; when not, it is held in memory (still listed, still flushed) and written by the next
 *  queue operation whose write lands. */
export async function enqueueMedia(
  incidentId: string,
  rowId: string,
  kind: 'photo' | 'audio',
  blob: Blob,
  filename: string,
  createdAt: string,
  localUrl?: string,
  target?: MediaTarget,
): Promise<boolean> {
  const id = mediaQueueId(rowId, kind, localUrl)
  const rev = newId('mq')
  return laneFor(incidentId).edit(async () => {
    const { items, known } = await readQueue(incidentId)
    const next = items.filter((i) => i.id !== id)
    next.push({ id, incidentId, rowId, kind, blob, filename, createdAt, attempts: 0, status: 'pending', rev, ...(localUrl ? { localUrl } : {}), ...(target ? { target } : {}) })
    return storeQueue(incidentId, next, known)
  })
}

export const listMediaQueue = async (incidentId: string): Promise<MediaQueueItem[]> => (await readQueue(incidentId)).items

/** Drop the whole queue for an incident (called when an incident is archived/closed). */
export const clearIncidentMedia = (incidentId: string): Promise<void> =>
  laneFor(incidentId).edit(() => { unstored.delete(incidentId); return idbDel(keyFor(incidentId)) })

/**
 * Drop an archived incident's queue — UNLESS something is still waiting in it.
 *
 * ⚠️ The Abschluss used to call `clearIncidentMedia` outright. Right for the ordinary case (every
 * blob is on the server by then and the queue is dead weight), destructive in the one that
 * actually happens: offline at Einsatzende, with photos and voice memos still pending. That
 * deleted exactly the media the Rapport had promised to send «bei Verbindung» — no warning, no
 * undo, and only on the copy that mattered.
 *
 * Returns how many items were kept, so the caller can say so. What stays goes up the next time
 * the incident is opened: the workspace drains the queue whenever the sync reports «synced».
 * A receipt counts as waiting too — its link is not acknowledged (the Abschluss replays them
 * after draining the Verlauf, useMediaOutbox · flushRecordOutboxes, so normally none is left).
 */
export function clearUploadedMedia(incidentId: string): Promise<number> {
  // in the lane: a capture enqueued between the check and the delete would be deleted with it
  return laneFor(incidentId).edit(async () => {
    const { items: pending, known } = await readQueue(incidentId)
    if (pending.length) return pending.length
    // a queue that could not be read may still hold captures: leave it for the next open
    if (known) await idbDel(keyFor(incidentId)).catch(() => {})
    return 0
  })
}

export type MediaUploader = (
  incidentId: string,
  blob: Blob,
  kind: 'photo' | 'audio',
  filename: string,
) => Promise<{ url: string }>

export interface FlushOutcome {
  uploaded: { id: string; rowId: string; kind: 'photo' | 'audio'; url: string; localUrl?: string; target?: MediaTarget }[]
  remaining: MediaQueueItem[]
}

/** Attempt every queued capture of an incident. A successful upload becomes a RECEIPT (its server
 *  URL, the bytes dropped — see the header) and is returned too; linking it to the timeline row
 *  is the caller's, from the stored receipts. A network drop leaves the item `pending` (attempts
 *  unchanged — it never got to the server); a real server error counts an attempt and flips to
 *  `failed` past MAX_ATTEMPTS. Receipts are never uploaded again, `retry` or not. Never throws —
 *  a bad flush just leaves work queued for the next one. */
export function flushMediaQueue(incidentId: string, upload: MediaUploader, { retry = false }: { retry?: boolean } = {}): Promise<FlushOutcome> {
  const lane = laneFor(incidentId)
  return lane.flush(async () => {
    const { items } = await lane.edit(() => readQueue(incidentId))
    const uploaded: FlushOutcome['uploaded'] = []
    /** per attempted entry: its updated state (a receipt once it is on the server) */
    const settled: { item: MediaQueueItem; next: MediaQueueItem }[] = []
    for (const item of items) {
      if (isReceipt(item)) continue
      if (!retry && (item.status === 'failed' || (item.retryAt ?? 0) > Date.now())) continue
      // Older JSON fallbacks may already hold {} instead of a Blob. Keep the record visible
      // as failed, but never crash the restore/upload path or pretend the bytes are present.
      if (!(item.blob instanceof Blob)) {
        settled.push({ item, next: { ...item, status: 'failed', lastError: 'Stored media has no binary data' } })
        continue
      }
      try {
        const { url } = await upload(incidentId, item.blob, item.kind, item.filename)
        uploaded.push({ id: item.id, rowId: item.rowId, kind: item.kind, url, localUrl: item.localUrl, ...(item.target ? { target: item.target } : {}) })
        const { blob: _bytes, status: _status, lastError: _error, retryAt: _retryAt, ...entry } = item
        settled.push({ item, next: { ...entry, status: 'uploaded', url } })
      } catch (e) {
        // A network failure (offline / server unreachable) is not the item's fault — keep it
        // pending without burning an attempt. Only a reachable-but-rejecting server counts.
        const networkDown = !navigatorOnline() || isUnverifiable(e)
        const previous = retry && item.status === 'failed' ? 0 : item.attempts
        const attempts = networkDown ? previous : previous + 1
        const status: MediaStatus = !networkDown && attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
        const retryAt = Date.now() + Math.min(60_000, 5_000 * 2 ** attempts)
        settled.push({ item, next: { ...item, attempts, status, retryAt, lastError: e instanceof Error ? e.message : String(e) } })
      }
    }
    // Write back against the queue as it is NOW, not the snapshot above: whatever was captured
    // (or re-recorded) during the uploads stays exactly as it was stored.
    // A write that fails keeps the result in memory (storeQueue), so an upload that landed is not
    // re-sent from a stale stored copy while this page lives.
    const remaining = await lane.edit(async () => {
      const { items: current, known } = await readQueue(incidentId)
      const next = current.map((cur) => settled.find((x) => sameCapture(x.item, cur))?.next ?? cur)
      await storeQueue(incidentId, next, known)
      return next
    })
    return { uploaded, remaining }
  })
}

/** These receipts' links are acknowledged: drop them — each only while it is still the receipt
 *  it was (a capture queued again under the same id stays). Resolves whether the queue is
 *  durably stored, like enqueueMedia. */
export function retireMediaReceipts(incidentId: string, done: readonly MediaReceipt[]): Promise<boolean> {
  return laneFor(incidentId).edit(async () => {
    const { items, known } = await readQueue(incidentId)
    const next = items.filter((cur) => !(isReceipt(cur) && done.some((d) => sameCapture(d, cur))))
    if (next.length === items.length) return isMediaQueueDurable(incidentId)
    return storeQueue(incidentId, next, known)
  })
}

/** Test-only: forget the in-memory holdings (the IDB double is replaced per test). */
export function __resetMediaQueueForTests(): void {
  unstored.clear()
  lanes.clear()
}
