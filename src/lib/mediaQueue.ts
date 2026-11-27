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
// (a proxy timeout while the server was still storing) is retried under the capture's `rev`,
// which the server keeps as the upload id (api/media · upload_id) and answers with the file it
// already has – the bytes are stored once. A receipt keeps its `target`: an attachment's link goes to the Rapport,
// never to a Verlauf patch (useMediaOutbox).

import { ApiError } from './api'
import { idbDel, idbRead, idbSet } from './idb'
import { newId } from './ids'
import { serialQueue } from './serialQueue'
import { withTileEviction } from './tileEvict'

const PREFIX = 'kp-front-mediaq-'
const keyFor = (incidentId: string) => `${PREFIX}${incidentId}`

/** A capture's state: `pending` = waiting for its next automatic attempt (never attempted, offline,
 *  or the backend was down – 502/503/504); `failed` = the server rejected it repeatedly (a real
 *  error such as 413, not just no network or a backend restarting). */
export type MediaStatus = 'pending' | 'failed'
export type MediaTarget = 'attachment'

interface MediaQueueEntry {
  id: string                     // queue id — see mediaQueueId
  incidentId: string
  rowId: string                  // timeline event id the media hangs off
  kind: 'photo' | 'audio'
  filename: string
  createdAt: string              // ISO — when the capture was made
  attempts: number               // count of failed upload attempts that got an HTTP answer (network drops don't count)
  /** Tries in a row that got no answer at all (offline, a link that routes nowhere). Only grows
   *  the pause, never counts toward `failed`; gone again on any server answer. Absent = 0, also
   *  on entries stored before 27.11.2026. */
  misses?: number
  lastError?: string
  /** Earliest automatic retry. Failed items wait for the operator instead. */
  retryAt?: number
  /** the row's blob: URL this capture stands for — the picture the server URL replaces once
   *  it uploads. Absent on audio (a row has one voice memo) and on pre-2026-08 queue entries. */
  localUrl?: string
  /** which CAPTURE this entry is — minted per capture (by its direct upload attempt, or here at
   *  enqueue). The queue id alone cannot say it: a re-recorded voice memo reuses its row's id,
   *  and a flush that uploaded the old recording must not drop the new one queued behind it.
   *  Also the upload id every attempt sends (api/media · upload_id), so a retry after a lost
   *  response is not stored twice. Absent on entries queued before 23.09.2026. */
  rev?: string
  /** Absent for journal media; Rapport-Beilagen restore/swap only the attachment with rowId. */
  target?: MediaTarget
  /** A journal photo's index in its row's list AS CAPTURED. The stored row lists only uploaded
   *  pictures (journalStore · stripSessionUrls) and its `photoGeo` stays aligned by the captured
   *  index, so a capture restored after a reload, or a receipt linked then, goes back to its own
   *  place instead of the end of the list (hunt 24.11.2026, offline-sync F3: the Karte marker of
   *  photo 1 showed photo 2). Absent on entries queued before, and on audio and Beilagen. */
  slot?: number
}
/** Still to upload: the bytes ride along. Every entry stored before 26.10.2026 is one. */
export interface MediaCapture extends MediaQueueEntry { status: MediaStatus; blob: Blob }
/** Uploaded, link owed: the server has the bytes under `url`, its row (or Beilage) may not know yet
 *  (see the header). Retired by `retireMediaReceipts`. */
export interface MediaReceipt extends MediaQueueEntry { status: 'uploaded'; url: string }
export type MediaQueueItem = MediaCapture | MediaReceipt

export const isReceipt = (item: MediaQueueItem): item is MediaReceipt => item.status === 'uploaded'

/** After this many failed attempts that reached a server an item is surfaced as `failed` rather
 *  than an ever-pending upload the operator can't reason about – unless the last answer was a
 *  backend that is down (see BACKEND_DOWN). */
const MAX_ATTEMPTS = 3

/** A proxy's answer while the backend is down or restarting (a deploy). Retrying is safe – every
 *  attempt sends the capture's upload id, so the server stores it once – so these keep retrying
 *  by themselves, backed off, and never end `failed`. */
const BACKEND_DOWN = new Set([502, 503, 504])

/** Pause before the next automatic attempt: 5 s doubling per counted attempt or miss, capped at 5 min,
 *  ±10 % jitter so a fleet of tablets does not return in lockstep after an outage. */
const retryDelay = (attempts: number) => Math.round(Math.min(300_000, 5_000 * 2 ** attempts) * (0.9 + Math.random() * 0.2))

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

/** Shortest gap between two early tries of one capture on `due: 'reachable'`. The owner's
 *  decision (27.11.2026): a photo waiting out 5 min on a link that is back is too long at an
 *  Einsatz, and one try a minute cannot flood anything. */
const EARLY_TRY_SPACING_MS = 60_000

/** When each capture last had its early try on `due: 'reachable'`. A capture whose upload keeps
 *  failing re-arms connectivity · onReachable with every no-answer or 502/503/504, and the next
 *  answered poll would send its Blob again – so it gets an early try at most once per
 *  EARLY_TRY_SPACING_MS; its stored pause still runs as before. Only the upload landing forgets
 *  it. The browser's `online` event (`due: 'online'`) is not limited. In memory only: a reload
 *  starts from the stored pause. */
const triedEarly = new Map<string, number>()
const captureKey = (item: MediaQueueItem) => `${item.incidentId}|${item.id}|${item.rev ?? item.createdAt}`

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
 *  Resets it to `pending` for a fresh retry cycle. `uploadId`: the id the capture's direct
 *  upload already sent, so the retries are recognisably the same upload. Resolves whether the
 *  capture is DURABLY queued; when not, it is held in memory (still listed, still flushed) and written by the next
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
  uploadId?: string,
  slot?: number,
): Promise<boolean> {
  const id = mediaQueueId(rowId, kind, localUrl)
  const rev = uploadId ?? newId('mq')
  return laneFor(incidentId).edit(async () => {
    const { items, known } = await readQueue(incidentId)
    const next = items.filter((i) => i.id !== id)
    next.push({ id, incidentId, rowId, kind, blob, filename, createdAt, attempts: 0, status: 'pending', rev, ...(localUrl ? { localUrl } : {}), ...(target ? { target } : {}), ...(slot != null ? { slot } : {}) })
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
  /** the capture's id, the same on every attempt (api/media · upload_id) */
  uploadId?: string,
) => Promise<{ url: string }>

export interface FlushOutcome {
  uploaded: { id: string; rowId: string; kind: 'photo' | 'audio'; url: string; localUrl?: string; target?: MediaTarget }[]
  remaining: MediaQueueItem[]
  /** A `due: 'reachable'` flush skipped a capture whose early try was too recent (triedEarly):
   *  the earliest time one of them may try early again, when that comes before its stored pause
   *  ends. The caller flushes `due: 'reachable'` again then, so a recovery signal that came
   *  during the spacing is not lost. */
  deferredUntil?: number
}

/** Attempt every queued capture of an incident. A successful upload becomes a RECEIPT (its server
 *  URL, the bytes dropped — see the header) and is returned too; linking it to the timeline row
 *  is the caller's, from the stored receipts. A network drop leaves the item `pending` (attempts
 *  unchanged — it never got to the server). A 502/503/504 counts an attempt (the backoff grows)
 *  but stays `pending`: the backend comes back. Any other HTTP error flips to `failed` once
 *  attempts reach MAX_ATTEMPTS – so one after a long outage fails at once. One attempt per item
 *  per flush, and none before its `retryAt` – unless `due`: connectivity is back, so a pause
 *  still running from a dead link is over (`'online'`: the browser's event; `'reachable'`: the
 *  server answered another request – an early try per capture at most once a minute, see
 *  triedEarly). Failed items still wait for `retry`. No answer at all counts a miss instead (`misses`): the pause doubles while the link stays dead. Receipts
 *  are never uploaded again, `retry` or not. Never throws — a bad flush just leaves work queued
 *  for the next one. */
export function flushMediaQueue(incidentId: string, upload: MediaUploader, { retry = false, due }: { retry?: boolean; due?: 'online' | 'reachable' } = {}): Promise<FlushOutcome> {
  const lane = laneFor(incidentId)
  return lane.flush(async () => {
    const { items } = await lane.edit(() => readQueue(incidentId))
    const uploaded: FlushOutcome['uploaded'] = []
    /** per attempted entry: its updated state (a receipt once it is on the server) */
    const settled: { item: MediaQueueItem; next: MediaQueueItem }[] = []
    let deferredUntil: number | undefined
    for (const item of items) {
      if (isReceipt(item)) continue
      const key = captureKey(item)
      const early = (item.retryAt ?? 0) > Date.now()
      const spacedAt = (triedEarly.get(key) ?? -Infinity) + EARLY_TRY_SPACING_MS
      if (!retry && item.status !== 'failed' && early && due === 'reachable' && spacedAt > Date.now()) {
        // the stored pause wins when it ends first: the normal retry comes then anyway
        if (spacedAt < (item.retryAt ?? 0)) deferredUntil = Math.min(deferredUntil ?? Infinity, spacedAt)
        continue
      }
      if (!retry && (item.status === 'failed' || (early && !due))) continue
      // only the reachable try is rationed: an `online` try that misses leaves it unused
      if (early && !retry && due === 'reachable') triedEarly.set(key, Date.now())
      // Older JSON fallbacks may already hold {} instead of a Blob. Keep the record visible
      // as failed, but never crash the restore/upload path or pretend the bytes are present.
      if (!(item.blob instanceof Blob)) {
        settled.push({ item, next: { ...item, status: 'failed', lastError: 'Stored media has no binary data' } })
        continue
      }
      try {
        const { url } = await upload(incidentId, item.blob, item.kind, item.filename, item.rev)
        uploaded.push({ id: item.id, rowId: item.rowId, kind: item.kind, url, localUrl: item.localUrl, ...(item.target ? { target: item.target } : {}) })
        const { blob: _bytes, status: _status, lastError: _error, retryAt: _retryAt, misses: _misses, ...entry } = item
        settled.push({ item, next: { ...entry, status: 'uploaded', url } })
        triedEarly.delete(key)
      } catch (e) {
        // No answer at all (offline, our own timeout) is not the item's fault — keep it pending
        // without burning an attempt; it counts a miss, so the pause still grows. A backend that
        // is down counts (the pause grows) but never fails the item; any other HTTP answer counts
        // toward `failed`. Any answer ends the run of misses.
        const networkDown = !navigatorOnline() || (e instanceof ApiError && e.status === 0)
        const backendDown = e instanceof ApiError && BACKEND_DOWN.has(e.status)
        const previous = retry && item.status === 'failed' ? 0 : item.attempts
        const attempts = networkDown ? previous : previous + 1
        const status: MediaStatus = !networkDown && !backendDown && attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
        const misses = item.misses ?? 0
        const retryAt = Date.now() + retryDelay(networkDown ? attempts + misses : attempts)
        const { misses: _misses, ...rest } = item
        settled.push({ item, next: { ...rest, attempts, status, retryAt, lastError: e instanceof Error ? e.message : String(e), ...(networkDown ? { misses: misses + 1 } : {}) } })
      }
    }
    // Write back against the queue as it is NOW, not the snapshot above: whatever was captured
    // (or re-recorded) during the uploads stays exactly as it was stored.
    // A write that fails keeps the result in memory (storeQueue), so an upload that landed is not
    // re-sent from a stale stored copy while this page lives.
    const remaining = await lane.edit(async () => {
      const { items: current, known } = await readQueue(incidentId)
      // nothing was tried and nothing waits in memory for a write that lands: the stored queue,
      // Blobs and all, is already this one
      if (!settled.length && !unstored.has(incidentId)) return current
      const next = current.map((cur) => settled.find((x) => sameCapture(x.item, cur))?.next ?? cur)
      await storeQueue(incidentId, next, known)
      return next
    })
    return { uploaded, remaining, ...(deferredUntil != null ? { deferredUntil } : {}) }
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
  triedEarly.clear()
  lanes.clear()
}
