// The device copy of every Objektbesuch (docs/object-visits.md · Device). A visit exists HERE
// first and on the server only after a save point; until then this store is the only copy.
//
// Keys:   kp-front-ov-index          the ids of the visits this device holds
//         kp-front-ov-<visitId>      one LocalVisit (no blobs — the record may fall back)
//         kp-front-ov-att-<attId>    one photo: blob + thumbnail (IndexedDB ONLY, idbSetStrict)
//
// The rules are the media queue's (lib/mediaQueue), in their own key space:
//   · a write that did not land is never reported as saved: the record is HELD in page memory,
//     still sent by the outbox, still exported by «Als Datei sichern», and the UI says
//     «Nicht gespeichert» until a later write lands;
//   · a failed READ is not «nothing»: an update over a slot that could not be read is refused,
//     never applied to an empty record (lib/idb · idbRead);
//   · a Blob never goes to the localStorage fallback, where it would serialise to `{}`;
//   · every read-modify-write of one visit runs through ONE lane (lib/serialQueue), so an edit
//     and the outbox's merge never write over each other.

import { idbDel, idbKeys, idbRead, idbSet, idbSetStrict, type IdbRead } from '../lib/idb'
import { serialQueue } from '../lib/serialQueue'
import { withTileEviction } from '../lib/tileEvict'
import type { Delivery, Person, VisitDoc } from './types'

export const INDEX_KEY = 'kp-front-ov-index'
export const visitKey = (id: string) => `kp-front-ov-${id}`
export const attKey = (attId: string) => `kp-front-ov-att-${attId}`

/** Why the last send did not go through (null = it did, or nothing was tried). */
export interface OutboxError {
  /** `contended` = merged and resent MAX_ROUNDS times and still behind: backs off, says «Konflikt» */
  kind: 'offline' | 'auth' | 'forbidden' | 'disabled' | 'rejected' | 'server' | 'attachment' | 'contended'
  /** the account the refusal was for — a 403 parks the visit for THAT account only */
  user?: string | null
  /** the server's German sentence, where it gave one */
  detail?: string
  at: string
}

export interface PendingOp {
  opId: string
  baseRevision: number | null
  doc: VisitDoc
}

export interface LocalVisit {
  doc: VisitDoc
  /** the last revision the server accepted from or sent to this device — the merge's ancestor */
  base: { revision: number; doc: VisitDoc } | null
  /** edited since `base` */
  dirty: boolean
  /** when this record was last written on the device */
  savedAt: string
  /** the server's answer about the latest revision this device sent */
  sent: { revision: number; ready: boolean; missing: string[] } | null
  lastError: OutboxError | null
  // ── device bookkeeping beyond the contract's record shape ──
  /** the write in flight, persisted BEFORE it is sent: a retry after a lost answer re-sends the
   *  SAME opId and gets the server's first answer back instead of a conflict with itself */
  op?: PendingOp | null
  /** a save point asked for a revision that has not been accepted yet */
  wantSave?: boolean
  /** attachment ids the server confirmed it holds (201/200) */
  uploaded?: string[]
  /** who started it (drafts are listed per user; the background sender sends only this
   *  account's work — never a colleague's on a shared tablet) */
  owner?: string | null
  /** the account whose save point is pending (`wantSave` / `op`) — it, and only it, sends it */
  saveBy?: string | null
  /** photos the server refused (409 another hash, 422): attId → sha256. Not re-uploaded until
   *  an edit or «Jetzt senden» clears them. */
  refusedPhotos?: Record<string, string>
  /** the revision whose acknowledged photos were already released (outbox · releaseSettled) */
  releasedAt?: number | null
  /** what the server last said about the visit beyond the document */
  server?: {
    createdBy?: Person | null
    createdAt?: string | null
    updatedAt?: string | null
    deliveries?: Delivery[]
    findings?: number
    url?: string | null
  } | null
}

export interface LocalAttachment {
  /** the prepared photo (null once released after delivery — the thumbnail stays) */
  blob: Blob | null
  thumb: Blob | null
  type: string
  sha256: string
  size: number
  visitId?: string
}

// ─── memory holdings (writes that did not land) ─────────────────────────────────────────────

const heldVisits = new Map<string, LocalVisit>()
/** EDITS that could not even be applied: the stored record could not be read. Kept in order and
 *  replayed onto the record by the next update that can read it (and shown by `readVisit`
 *  meanwhile) — an edit is never lost to a failed read, and the visit says «Nicht gespeichert»
 *  until it has landed. */
const queuedEdits = new Map<string, ((cur: LocalVisit) => LocalVisit)[]>()
const heldAtts = new Map<string, LocalAttachment>()
/** ids written while the index could not be read — added at the next index write that can */
const heldIndex = new Set<string>()

const lanes = new Map<string, ReturnType<typeof serialQueue>>()
const laneFor = (id: string) => {
  let l = lanes.get(id)
  if (!l) { l = serialQueue(); lanes.set(id, l) }
  return l
}
const indexLane = serialQueue()

// ─── change events (this tab + the others) ──────────────────────────────────────────────────

const listeners = new Set<(id: string) => void>()
let channel: BroadcastChannel | null = null
function bc(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  try {
    channel = new BroadcastChannel('kp-ov')
    channel.onmessage = (e: MessageEvent) => {
      const id = (e.data as { id?: unknown } | null)?.id
      if (typeof id === 'string') {
        // another tab wrote it: our memory copy (if any) is no longer the newest
        for (const l of [...listeners]) l(id)
      }
    }
  } catch { channel = null }
  return channel
}

/** Subscribe to «visit `id` changed» — here or in another tab. Returns an unsubscribe. */
export function onVisitChanged(cb: (id: string) => void): () => void {
  bc()
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function emitChanged(id: string): void {
  for (const l of [...listeners]) l(id)
  try { bc()?.postMessage({ type: 'visit', id }) } catch { /* closed channel — this tab still heard it */ }
}

// ─── index ──────────────────────────────────────────────────────────────────────────────────

export async function readIndex(): Promise<IdbRead<string[]>> {
  const r = await idbRead<string[]>(INDEX_KEY)
  if (!r.ok) return r
  const ids = Array.isArray(r.value) ? r.value.filter((x) => typeof x === 'string') : []
  for (const id of [...heldIndex, ...heldVisits.keys()]) if (!ids.includes(id)) ids.push(id)
  return { ok: true, value: ids }
}

function addToIndex(id: string): Promise<boolean> {
  return indexLane(async () => {
    const r = await idbRead<string[]>(INDEX_KEY)
    if (!r.ok) { heldIndex.add(id); return false }
    const ids = Array.isArray(r.value) ? [...r.value] : []
    let changed = false
    for (const x of [id, ...heldIndex]) if (!ids.includes(x)) { ids.push(x); changed = true }
    if (!changed) { heldIndex.clear(); return true }
    const ok = await withTileEviction(() => idbSet(INDEX_KEY, ids))
    if (ok) heldIndex.clear()
    else heldIndex.add(id)
    return ok
  })
}

// ─── visits ─────────────────────────────────────────────────────────────────────────────────

async function readRaw(id: string): Promise<IdbRead<LocalVisit>> {
  const held = heldVisits.get(id)
  if (held) return { ok: true, value: held }
  return idbRead<LocalVisit>(visitKey(id))
}

const applyQueued = (id: string, rec: LocalVisit | null): LocalVisit | null => {
  const q = queuedEdits.get(id)
  if (!rec || !q?.length) return rec
  return q.reduce((r, f) => f(r), rec)
}

/** One visit: the held copy if a write of it failed, else the stored one — with any queued edit
 *  applied. `ok: false` = the store could not answer — NOT «no such visit». */
export async function readVisit(id: string): Promise<IdbRead<LocalVisit>> {
  const r = await readRaw(id)
  return r.ok ? { ok: true, value: applyQueued(id, r.value) } : r
}

/** Run a read-modify-write under a cross-tab Web Lock (`kp-ov-rec-<id>`): two tabs editing one
 *  visit would otherwise each read, change and write — and the first write would be lost. Held
 *  only for the RMW itself (the outbox's own flush lock is another name), so nothing nests. A
 *  browser that refuses the lock (an inactive document) runs it unlocked, never re-queued. */
async function withRecordLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return fn()
  let ran = false
  try {
    return await locks.request(`kp-ov-rec-${id}`, async () => { ran = true; return fn() })
  } catch (e) {
    if (ran) throw e
    return fn()
  }
}

export interface UpdateResult {
  /** the record as it now stands (in storage or in memory) — null when the update was refused
   *  or the updater returned null */
  rec: LocalVisit | null
  /** false = the store could not be READ, so nothing was changed */
  ok: boolean
  /** true = the record is in storage; false = it lives only in this page */
  durable: boolean
}

/**
 * Read-modify-write one visit, in its lane. `fn` gets the current record (null = none) and
 * returns the next one, or null to leave it alone.
 */
export function updateVisit(
  id: string,
  fn: (cur: LocalVisit | null) => LocalVisit | null,
  { queueOnFailure = false }: {
    /** an EDIT of an existing visit: on a failed read keep it queued (and replay it) instead of
     *  refusing it — `fn` must then accept any record, it may run later on a newer one */
    queueOnFailure?: boolean
  } = {},
): Promise<UpdateResult> {
  return laneFor(id)(() => withRecordLock(id, async () => {
    const raw = await readRaw(id)
    if (!raw.ok) {
      if (queueOnFailure) {
        const q = queuedEdits.get(id) ?? []
        q.push((r) => fn(r) ?? r)
        queuedEdits.set(id, q)
      }
      return { rec: null, ok: false, durable: false }
    }
    const pending = !!queuedEdits.get(id)?.length
    const cur = applyQueued(id, raw.value)
    const next = fn(cur) ?? (pending ? cur : null)
    if (!next) return { rec: cur, ok: true, durable: !heldVisits.has(id) && !queuedEdits.has(id) }
    const stamped: LocalVisit = { ...next, savedAt: new Date().toISOString() }
    const ok = await withTileEviction(() => idbSet(visitKey(id), stamped))
    // the queued edits are IN `stamped` now: stored, or held with it
    queuedEdits.delete(id)
    if (ok) heldVisits.delete(id)
    else heldVisits.set(id, stamped)
    if (!raw.value) await addToIndex(id)
    emitChanged(id)
    return { rec: stamped, ok: true, durable: ok }
  }))
}

/** Is this visit's record — and every photo it shows — in storage, not only in this page? */
export function isVisitDurable(id: string, doc?: VisitDoc | null): boolean {
  if (heldVisits.has(id) || queuedEdits.has(id)) return false
  return !(doc?.photos ?? []).some((p) => heldAtts.has(p.id))
}

/** Every visit this device holds. `ok: false` when the index could not be read (the list on
 *  screen is then not the whole truth, and must say so); unreadable records are counted. */
export async function listLocalVisits(): Promise<{ ok: boolean; visits: LocalVisit[]; unreadable: number }> {
  const idx = await readIndex()
  const ids = idx.ok ? idx.value ?? [] : [...heldVisits.keys()]
  const visits: LocalVisit[] = []
  let unreadable = 0
  for (const id of ids) {
    const r = await readVisit(id)
    if (!r.ok) { unreadable++; continue }
    if (r.value) visits.push(r.value)
  }
  return { ok: idx.ok, visits, unreadable }
}

/** This device's (and this person's) open draft for `(object, workRef)` — what a launch link
 *  resumes before it mints a new visit. */
export function findOpenDraft(visits: LocalVisit[], objectId: string, workRef: string | null | undefined, owner: string | null | undefined): LocalVisit | null {
  const ref = workRef || null
  const hits = visits.filter((v) =>
    v.doc.lifecycle === 'draft'
    && v.doc.object?.id === objectId
    && (v.doc.workRef || null) === ref
    && (!owner || !v.owner || v.owner === owner))
  hits.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  return hits[0] ?? null
}

/** Put a new visit on the device (nothing is sent until the first save point). Resolves the
 *  record as stored — or the one already under that id. */
export async function createLocalVisit(doc: VisitDoc, owner: string | null): Promise<UpdateResult> {
  return updateVisit(doc.id, (cur) => cur ? null : {
    doc, base: null, dirty: true, savedAt: new Date().toISOString(), sent: null, lastError: null, owner,
  })
}

// ─── attachments ────────────────────────────────────────────────────────────────────────────

/** Store a photo. IndexedDB only; a refusal holds it in memory and resolves false. */
export async function putAttachment(attId: string, rec: LocalAttachment): Promise<boolean> {
  const ok = await withTileEviction(() => idbSetStrict(attKey(attId), rec))
  if (ok) heldAtts.delete(attId)
  else heldAtts.set(attId, rec)
  return ok
}

export async function readAttachment(attId: string): Promise<IdbRead<LocalAttachment>> {
  const held = heldAtts.get(attId)
  if (held) return { ok: true, value: held }
  return idbRead<LocalAttachment>(attKey(attId))
}

/**
 * Drop a photo's full bytes, keep its thumbnail and metadata (outbox · releaseSettled
 * decides WHEN). IndexedDB only, and only over a record that was read: a failed write leaves the
 * full photo where it was. True when released.
 */
export async function releaseBlob(attId: string, { requireThumb = true } = {}): Promise<boolean> {
  if (heldAtts.has(attId)) return false // not even stored yet
  const r = await idbRead<LocalAttachment>(attKey(attId))
  if (!r.ok || !r.value?.blob || (requireThumb && !r.value.thumb)) return false
  return idbSetStrict(attKey(attId), { ...r.value, blob: null })
}

/** Every photo this device holds for one visit (by the `visitId` each record carries). `ok:
 *  false` when the store could not list them — then nothing may be deleted on its account. */
export async function attachmentsOf(visitId: string): Promise<{ ok: boolean; ids: string[] }> {
  const keys = await idbKeys('kp-front-ov-att-')
  if (!keys.ok) return { ok: false, ids: [] }
  const ids: string[] = []
  for (const k of keys.value ?? []) {
    const attId = k.slice('kp-front-ov-att-'.length)
    const a = await idbRead<LocalAttachment>(k)
    if (!a.ok) return { ok: false, ids: [] }
    if (a.value?.visitId === visitId) ids.push(attId)
  }
  for (const [attId, a] of heldAtts) if (a.visitId === visitId && !ids.includes(attId)) ids.push(attId)
  return { ok: true, ids }
}

/** Delete one photo from the device entirely (its bytes are on the server, or it was never
 *  anywhere but here and the visit was discarded). */
export async function deleteAttachment(attId: string): Promise<void> {
  heldAtts.delete(attId)
  await idbDel(attKey(attId))
}

/**
 * Take a visit off this device: the record, its photos, its index entry. ONLY for a draft that
 * was discarded before it ever reached the server (after the person confirmed it) — anything
 * the server knows stays as a tombstone.
 */
export async function forgetVisit(id: string): Promise<boolean> {
  const atts = await attachmentsOf(id)
  if (!atts.ok) return false
  for (const a of atts.ids) await deleteAttachment(a)
  heldVisits.delete(id)
  queuedEdits.delete(id)
  await idbDel(visitKey(id))
  await indexLane(async () => {
    const r = await idbRead<string[]>(INDEX_KEY)
    if (r.ok && Array.isArray(r.value)) await idbSet(INDEX_KEY, r.value.filter((x) => x !== id))
  })
  heldIndex.delete(id)
  emitChanged(id)
  return true
}

/** This device's own id (a tiny device flag): who made a «Zwei Fassungen» card. */
export function deviceId(): string {
  try {
    const k = 'kp-ov-device'
    let v = localStorage.getItem(k)
    if (!v) { v = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem(k, v) }
    return v
  } catch {
    return memoryDevice
  }
}
const memoryDevice = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Retry every held write (a later moment may have room again). Returns how many landed. */
export async function retryHeld(): Promise<number> {
  let landed = 0
  for (const [attId, rec] of [...heldAtts]) if (await putAttachment(attId, rec)) landed++
  for (const id of [...new Set([...heldVisits.keys(), ...queuedEdits.keys()])]) {
    // `cur => cur` writes the record back — with the queued edits, once it can be read
    const r = await updateVisit(id, (cur) => cur)
    if (r.durable) landed++
  }
  return landed
}

/** Test-only: forget every memory holding, lane and listener. */
export function __resetStoreForTests(): void {
  heldVisits.clear()
  heldAtts.clear()
  heldIndex.clear()
  queuedEdits.clear()
  lanes.clear()
  listeners.clear()
  try { channel?.close() } catch { /* already closed */ }
  channel = null
}
