// Sending visits to the server (docs/object-visits.md · «Save points», «Conflict», «Auth expiry»).
//
// A save point asks for a REVISION (`wantSave`); the outbox turns the device copy into one:
//
//   1. the document first — `PUT /{id}` with `{opId, baseRevision, doc}`. The opId is minted
//      and PERSISTED with the document it carries before the request leaves (`rec.op`), so a
//      retry after a lost answer sends the SAME opId and the server replays its first answer —
//      never a second revision, never a conflict with our own write;
//   2. then every photo the server is missing (or that this device has and the server has not
//      confirmed) — `PUT /{id}/attachments/{attId}` with its SHA-256.
//
// Answers: 409 `revision_conflict` → three-way merge (merge.ts) → resend silently (the merged
// document carries any «Zwei Fassungen» in `conflicts[]`), at most MAX_ROUNDS times, then
// `contended` (backs off, says «Konflikt»); 401 → «Anmeldung nötig», the work and the op stay for
// the replay; 403 → parked for that account, op kept; network/502–504 → kept, retried when the
// server answers again; 422 → the server refused this document: kept, said, not retried until the
// next edit. A refused PHOTO (409/422) is remembered by hash and not re-sent until an edit.
//
// Cross-tab: a Web Lock `kp-ov-<visitId>` around a flush (a second tab skips, the first one is
// sending); `BroadcastChannel('kp-ov')` (store.ts) tells the other tabs to re-read.

import { ApiError, isUnverifiable } from '../lib/api'
import { newId } from '../lib/ids'
import { onReachable } from '../lib/connectivity'
import { serialQueue } from '../lib/serialQueue'
import * as api from './api'
import { sameDoc, stripServer } from './doc'
import { mergeVisit } from './merge'
import {
  attachmentsOf, deleteAttachment, deviceId, listLocalVisits, readAttachment, readVisit, releaseBlob, updateVisit,
  type LocalVisit, type OutboxError,
} from './store'
import type { ServerVisit } from './types'

export interface OutboxDeps {
  put: typeof api.putVisit
  putAtt: typeof api.putAttachment
  /** a FRESH read of the server's copy — what releasing a photo's bytes is decided on */
  get: typeof api.getVisit
}

const defaultDeps: OutboxDeps = { put: api.putVisit, putAtt: api.putAttachment, get: api.getVisit }

/** What one flush came to — the runner backs off on `offline`/`server`/`contended`, stops on
 *  the rest. `contended` = merged and resent MAX_ROUNDS times and still behind another device. */
export type FlushOutcome = 'done' | 'nothing' | 'busy' | 'offline' | 'auth' | 'refused' | 'server' | 'unreadable' | 'contended'

/** At most this many merges in one flush: a visit two devices are typing into at the same
 *  second would otherwise ping-pong. The next save point carries on. */
const MAX_ROUNDS = 4

// ─── «Wird gesendet» ────────────────────────────────────────────────────────────────────────

const flushing = new Set<string>()
const flushListeners = new Set<() => void>()
const setFlushing = (id: string, on: boolean) => {
  if (on) flushing.add(id); else flushing.delete(id)
  for (const l of [...flushListeners]) l()
}
export const isFlushing = (id: string): boolean => flushing.has(id)
export function subscribeFlushing(cb: () => void): () => void {
  flushListeners.add(cb)
  return () => { flushListeners.delete(cb) }
}

// ─── helpers ────────────────────────────────────────────────────────────────────────────────

/** Does the device copy hold something the server has no revision of? A draft discarded before
 *  it was ever sent owes nothing: it never existed anywhere else. */
export function owesRevision(rec: LocalVisit): boolean {
  if (!rec.base && rec.doc.lifecycle === 'discarded') return false
  return rec.dirty || !rec.base
}

/** Has this visit anything to send? (A revision asked for, a write in flight, or a photo.) */
export function hasWork(rec: LocalVisit): boolean {
  if (rec.op) return true
  if (rec.wantSave && owesRevision(rec)) return true
  return rec.base != null && pendingUploads(rec).length > 0
}

/** The photo ids this device should still upload: the server's `missing` and every photo of the
 *  document the server has not confirmed. (A photo of another device's is skipped when sending:
 *  this device has no bytes for it.) */
export function pendingUploads(rec: LocalVisit): string[] {
  const done = new Set(rec.uploaded ?? [])
  const refused = rec.refusedPhotos ?? {}
  const ids = [...(rec.sent?.missing ?? []), ...rec.doc.photos.map((p) => p.id)]
  return [...new Set(ids)].filter((id) => !done.has(id) && !(id in refused))
}

/** Which account owes this visit's pending send: the one that asked for the save point, else
 *  the one that started it. The background sender sends only its own account's work. */
export const responsible = (rec: LocalVisit): string | null => rec.saveBy ?? rec.owner ?? null

/** The server photos it holds (its `photos` minus `missing`) — known, never uploaded again. */
const storedOnServer = (v: ServerVisit): string[] => {
  const missing = new Set(Array.isArray(v.missing) ? v.missing : [])
  return (Array.isArray(v.photos) ? v.photos : []).map((p) => p.id).filter((id) => !missing.has(id))
}

export function classify(e: unknown): OutboxError {
  const at = new Date().toISOString()
  if (!(e instanceof ApiError)) return { kind: 'offline', at }
  if (isUnverifiable(e)) return { kind: 'offline', at }
  if (e.status === 401) return { kind: 'auth', at }
  if (e.status === 403) return { kind: 'forbidden', detail: e.detail, at }
  if (e.status === 404 && api.isModuleDisabled(e)) return { kind: 'disabled', detail: e.detail, at }
  if (e.status >= 500 || e.status === 429) return { kind: 'server', detail: e.detail, at }
  return { kind: 'rejected', detail: e.detail, at }
}

const outcomeOf = (err: OutboxError): FlushOutcome =>
  err.kind === 'offline' ? 'offline' : err.kind === 'auth' ? 'auth' : err.kind === 'server' ? 'server'
    : err.kind === 'contended' ? 'contended' : 'refused'

const serverMeta = (v: ServerVisit): LocalVisit['server'] => ({
  createdBy: v.createdBy ?? null,
  createdAt: v.createdAt ?? null,
  updatedAt: v.updatedAt ?? null,
  deliveries: Array.isArray(v.deliveries) ? v.deliveries : [],
  findings: v.findings,
  url: v.url ?? null,
})

/** Run `fn` under the visit's Web Lock. Another tab holding it ⇒ 'busy' (it is sending). A
 *  request the browser rejects (an inactive document) is NOT re-queued (lib/tabLock · Web Locks). */
async function withVisitLock<T>(id: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return fn()
  try {
    return await locks.request(`kp-ov-${id}`, { ifAvailable: true }, async (lock) => (lock ? fn() : 'busy' as const))
  } catch {
    return 'busy'
  }
}

const lanes = new Map<string, ReturnType<typeof serialQueue>>()
const laneFor = (id: string) => {
  let l = lanes.get(id)
  if (!l) { l = serialQueue(); lanes.set(id, l) }
  return l
}

// ─── save points ────────────────────────────────────────────────────────────────────────────

/** A save point: ask for a revision of whatever the device holds now, then send it. `actor` is
 *  the signed-in account (it owns the pending send); `manual` («Jetzt senden») also retries the
 *  photos the server refused. */
export async function requestSave(
  id: string,
  deps: OutboxDeps = defaultDeps,
  { actor = null, manual = false }: { actor?: string | null; manual?: boolean } = {},
): Promise<FlushOutcome> {
  await updateVisit(id, (cur) => {
    if (!cur) return null
    const ask = owesRevision(cur) && !cur.wantSave
    const clearRefused = manual && !!cur.refusedPhotos && Object.keys(cur.refusedPhotos).length > 0
    if (!ask && !clearRefused && !(actor && (cur.wantSave || cur.op) && cur.saveBy !== actor)) return null
    return {
      ...cur,
      ...(ask ? { wantSave: true } : {}),
      ...(actor && (ask || cur.wantSave || cur.op) ? { saveBy: actor } : {}),
      ...(clearRefused ? { refusedPhotos: {}, lastError: cur.lastError?.kind === 'attachment' ? null : cur.lastError } : {}),
    }
  })
  return flushVisit(id, deps)
}

/** Send what this visit owes the server: the document (if a revision is due), then photos. */
export function flushVisit(id: string, deps: OutboxDeps = defaultDeps): Promise<FlushOutcome> {
  return laneFor(id)(async () => {
    const r = await withVisitLock(id, () => flushLocked(id, deps))
    for (const l of [...outcomeListeners]) l(r)
    return r
  })
}

// ─── «a send did not get through» — whoever started it, the runner takes it from there ────────

const outcomeListeners = new Set<(o: FlushOutcome) => void>()
/** Every flush's outcome — a save point the visit page asked for while offline included. */
export function onFlushOutcome(cb: (o: FlushOutcome) => void): () => void {
  outcomeListeners.add(cb)
  return () => { outcomeListeners.delete(cb) }
}
const waitsOnNetwork = (o: FlushOutcome) => o === 'offline' || o === 'server' || o === 'busy' || o === 'unreadable' || o === 'contended'

/**
 * Free the device once the server provably holds the visit (storage growth over a campaign of
 * 100+ visits). Decided on a FRESH `GET` — never on what this device last believed: the server's
 * latest revision must be this device's, ready, with nothing unsent here.
 *   · every photo the server confirmed (201/200 with its hash) AND lists as stored keeps only its
 *     thumbnail here; the full picture comes from `/attachments/{id}` when online. A photo
 *     without a thumbnail keeps its bytes;
 *   · a photo REMOVED from the visit, which the acknowledged revision no longer carries, leaves
 *     the device entirely;
 *   · a DISCARDED visit whose discarded revision the server holds keeps no photo here at all.
 * Once per revision (`releasedAt`). Returns how many photos were released or removed.
 */
export async function releaseSettled(id: string, deps: OutboxDeps = defaultDeps): Promise<number> {
  const r = await readVisit(id)
  if (!r.ok || !r.value) return 0
  const rec = r.value
  if (!rec.base || rec.dirty || rec.op || pendingUploads(rec).length > 0) return 0
  if (rec.releasedAt === rec.base.revision) return 0
  let v: ServerVisit
  try { v = await deps.get(id) } catch { return 0 }
  if (v.revision !== rec.base.revision || !v.ready) return 0
  const stored = new Set(storedOnServer(v))
  let n = 0
  if (v.lifecycle === 'discarded') {
    const atts = await attachmentsOf(id)
    if (!atts.ok) return 0
    for (const a of atts.ids) { await deleteAttachment(a); n++ }
  } else {
    const acked = new Set(rec.uploaded ?? [])
    for (const p of rec.doc.photos) if (acked.has(p.id) && stored.has(p.id) && await releaseBlob(p.id)) n++
    const inVisit = new Set([...rec.doc.photos.map((p) => p.id), ...(Array.isArray(v.photos) ? v.photos.map((p) => p.id) : [])])
    const atts = await attachmentsOf(id)
    if (atts.ok) for (const a of atts.ids) if (!inVisit.has(a)) { await deleteAttachment(a); n++ }
  }
  await updateVisit(id, (cur) => (cur && !cur.dirty && !cur.op && cur.base?.revision === v.revision
    ? { ...cur, releasedAt: v.revision, server: serverMeta(v) } : null))
  return n
}

async function flushLocked(id: string, deps: OutboxDeps): Promise<FlushOutcome> {
  const first = await readVisit(id)
  if (!first.ok) return 'unreadable'
  if (!first.value || !hasWork(first.value)) return 'nothing'
  setFlushing(id, true)
  try {
    const doc = await sendDocument(id, deps)
    if (doc !== 'done' && doc !== 'nothing') return doc
    const photos = await sendPhotos(id, deps)
    if (photos === 'done') await releaseSettled(id, deps)
    return photos
  } finally {
    setFlushing(id, false)
  }
}

async function sendDocument(id: string, deps: OutboxDeps): Promise<FlushOutcome> {
  let sent = false
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await readVisit(id)
    if (!r.ok) return 'unreadable'
    let rec = r.value
    if (!rec) return 'nothing'
    if (!rec.op) {
      if (!(rec.wantSave && owesRevision(rec))) return sent ? 'done' : 'nothing'
      // mint the op and PERSIST it before the request leaves (a lost answer replays it)
      // the op now IS that save point: a later save point (wantSave again) owes a revision after it
      const op = { opId: newId('ovo'), baseRevision: rec.base?.revision ?? null, doc: rec.doc }
      const u = await updateVisit(id, (cur) => (cur ? { ...cur, op, wantSave: false } : null))
      if (!u.rec) return 'unreadable'
      rec = u.rec
    }
    const op = rec.op!
    let answer: Awaited<ReturnType<OutboxDeps['put']>>
    try {
      answer = await deps.put(id, op)
    } catch (e) {
      const err = { ...classify(e), user: rec.saveBy ?? rec.owner ?? null }
      // a refusal of THIS document (422): the op is dead (replaying it collects the same 422) and
      // no revision is owed until the next edit. Everything else keeps the op for the replay —
      // a 403 too: it says this ACCOUNT may not write, not that the work is wrong; the visit is
      // parked for that account and goes up when its owner is signed in (flushAll)
      const dropOp = err.kind === 'rejected'
      await updateVisit(id, (cur) => (cur ? { ...cur, lastError: err, ...(dropOp ? { op: null, wantSave: false } : {}) } : null))
      return outcomeOf(err)
    }
    sent = true
    if (answer.kind === 'accepted') {
      const a = answer.answer
      const serverDoc = a.visit ? stripServer(a.visit) : op.doc
      await updateVisit(id, (cur) => {
        if (!cur) return null
        const still = !sameDoc(cur.doc, op.doc)
        return {
          ...cur,
          base: { revision: a.revision, doc: serverDoc },
          dirty: still,
          // edits made while this revision flew wait for the next save point like any other —
          // unless one was asked for after this op was minted (a lost answer, then «leaving»)
          wantSave: still ? !!cur.wantSave : false,
          op: null,
          sent: { revision: a.revision, ready: a.ready, missing: Array.isArray(a.missing) ? a.missing : [] },
          lastError: null,
          // the photos the server already holds are known — never «Fotos n/m» over them
          uploaded: a.visit ? [...new Set([...(cur.uploaded ?? []), ...storedOnServer(a.visit)])] : cur.uploaded,
          ...(a.visit ? { server: serverMeta(a.visit) } : {}),
        }
      })
      continue // a replayed op (lost answer) may still owe the newer edits: the loop asks
    }
    // 409: somebody else's revision landed first — merge against the common ancestor, resend
    const serverDoc = stripServer(answer.visit)
    const revision = answer.revision
    const visit = answer.visit
    await updateVisit(id, (cur) => {
      if (!cur) return null
      const merged = mergeVisit(cur.base?.doc ?? null, cur.doc, serverDoc, { by: cur.saveBy ?? cur.owner ?? null, device: deviceId() })
      const differs = !sameDoc(merged.doc, serverDoc)
      return {
        ...cur,
        doc: merged.doc,
        base: { revision, doc: serverDoc },
        dirty: differs,
        wantSave: differs,
        op: null,
        sent: { revision, ready: !!visit.ready, missing: Array.isArray(visit.missing) ? visit.missing : [] },
        lastError: null,
        uploaded: [...new Set([...(cur.uploaded ?? []), ...storedOnServer(visit)])],
        server: serverMeta(visit),
      }
    })
  }
  // still behind after MAX_ROUNDS merges (two devices saving into one visit at the same moment):
  // NOT «Gesendet» — say «Konflikt», keep the save point, and let the runner back off and retry
  const left = await readVisit(id)
  if (left.ok && left.value && (left.value.op || (left.value.wantSave && owesRevision(left.value)))) {
    await updateVisit(id, (cur) => (cur ? { ...cur, lastError: { kind: 'contended', at: new Date().toISOString() } } : null))
    return 'contended'
  }
  return 'done'
}

async function sendPhotos(id: string, deps: OutboxDeps): Promise<FlushOutcome> {
  const r = await readVisit(id)
  if (!r.ok) return 'unreadable'
  const rec = r.value
  if (!rec?.base) return 'done' // the visit must exist on the server first
  let refused = false
  for (const attId of pendingUploads(rec)) {
    const a = await readAttachment(attId)
    if (!a.ok || !a.value?.blob) continue // not on this device (another device's photo) or unreadable
    const att = a.value
    try {
      await deps.putAtt(id, attId, att.blob!, att.type, att.sha256)
    } catch (e) {
      const err = { ...classify(e), user: responsible(rec) }
      // nothing the next photo could change: the network, the session, the account, the module
      if (err.kind === 'offline' || err.kind === 'auth' || err.kind === 'server' || err.kind === 'forbidden' || err.kind === 'disabled') {
        await updateVisit(id, (cur) => (cur ? { ...cur, lastError: err } : null))
        return outcomeOf(err)
      }
      // THIS photo was refused (409 another hash under its id, 422 type/size): remembered by its
      // hash and not sent again in full on every pass — until an edit or «Jetzt senden»
      refused = true
      await updateVisit(id, (cur) => (cur ? {
        ...cur, lastError: { ...err, kind: 'attachment' }, refusedPhotos: { ...(cur.refusedPhotos ?? {}), [attId]: att.sha256 },
      } : null))
      continue
    }
    await updateVisit(id, (cur) => {
      if (!cur) return null
      const uploaded = [...new Set([...(cur.uploaded ?? []), attId])]
      const missing = (cur.sent?.missing ?? []).filter((m) => m !== attId)
      const sent = cur.sent ? { ...cur.sent, missing, ready: missing.length === 0 ? true : cur.sent.ready } : cur.sent
      const lastError = cur.lastError?.kind === 'attachment' ? cur.lastError : null
      return { ...cur, uploaded, sent, lastError }
    })
  }
  return refused ? 'refused' : 'done'
}

/**
 * Take the server's copy of a visit into the device store — a visit opened from another device's
 * work, or a newer revision of one this device holds. A device copy with work of its own (dirty,
 * a write in flight) keeps its document: the next send merges (409) against the server.
 */
export function adoptServerVisit(v: ServerVisit, viewer: string | null): Promise<LocalVisit | null> {
  const serverDoc = stripServer(v)
  const sent = { revision: v.revision, ready: !!v.ready, missing: Array.isArray(v.missing) ? v.missing : [] }
  // the visit's owner is who CREATED it — a colleague's draft opened here is not «mine»
  const owner = v.createdBy?.id ?? viewer
  return updateVisit(v.id, (cur) => {
    if (!cur) {
      return {
        doc: serverDoc, base: { revision: v.revision, doc: serverDoc }, dirty: false,
        savedAt: new Date().toISOString(), sent, lastError: null, owner, server: serverMeta(v),
        // what the server holds is not ours to upload
        uploaded: storedOnServer(v),
      }
    }
    if (cur.dirty || cur.op || (cur.base && cur.base.revision > v.revision)) {
      return { ...cur, server: serverMeta(v) }
    }
    return {
      ...cur, doc: serverDoc, base: { revision: v.revision, doc: serverDoc }, dirty: false, sent,
      server: serverMeta(v), uploaded: [...new Set([...(cur.uploaded ?? []), ...storedOnServer(v)])],
    }
  }).then((r) => r.rec)
}

/**
 * Flush every visit on this device that THIS account owes the server, one after another. On a
 * shared tablet a colleague's pending send is theirs: sent as this account it would be filed
 * under the wrong name, and a role that may not write would 403 it. A visit parked by a 403 for
 * this account waits for «Jetzt senden» (or another account). `user` undefined = every visit
 * (tests, a single-user device).
 */
export async function flushAll(deps: OutboxDeps = defaultDeps, { user }: { user?: string | null } = {}): Promise<FlushOutcome[]> {
  const { visits } = await listLocalVisits()
  const out: FlushOutcome[] = []
  for (const v of visits) {
    const who = responsible(v)
    const mine = user === undefined || !who || who === user
    const parked = v.lastError?.kind === 'forbidden' && user !== undefined && (v.lastError.user ?? who) === user
    if (hasWork(v)) { if (mine && !parked) out.push(await flushVisit(v.doc.id, deps)) }
    else if (v.base && v.releasedAt !== v.base.revision) await releaseSettled(v.doc.id, deps)
  }
  return out
}

// ─── the runner: when to try again ──────────────────────────────────────────────────────────

const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000]

/**
 * Keep the outbox going for as long as the app is signed in — mounted by App, not by the
 * Objektbesuche surface, so a visit captured offline goes up on the next start or reconnect even
 * if nobody opens it again (docs/object-visits.md · «Reconnect and reload resume»): on start, whenever the server
 * answers again (lib/connectivity · onReachable — reconnect is proven by an answer) or the
 * browser says `online`, and on a backoff while something waits on the network. A reload while
 * offline may never see an `online` event, so the timer is what eventually tries. Returns stop.
 */
export function startOutboxRunner(deps: OutboxDeps = defaultDeps, { user }: { user?: string | null } = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let step = 0
  let running = false
  let again = false

  const schedule = (ms: number) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void run() }, ms)
  }
  const run = async () => {
    if (stopped) return
    if (running) { again = true; return }
    running = true
    try {
      const out = await flushAll(deps, { user })
      if (out.some(waitsOnNetwork)) { schedule(BACKOFF_MS[Math.min(step, BACKOFF_MS.length - 1)]); step++ }
      else step = 0
    } finally {
      running = false
      if (again && !stopped) { again = false; void run() }
    }
  }
  const kick = () => { step = 0; void run() }
  // a save point the visit page asked for (leaving it, the app going to the background) that hit
  // no network: retry on the backoff even if no `online` event ever comes (a reload while
  // offline, a WLAN that routes nowhere)
  const offOutcome = onFlushOutcome((o) => {
    if (!stopped && !running && !timer && waitsOnNetwork(o)) schedule(BACKOFF_MS[Math.min(step, BACKOFF_MS.length - 1)])
  })
  const offReach = onReachable(kick)
  window.addEventListener('online', kick)
  void run()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    offOutcome()
    offReach()
    window.removeEventListener('online', kick)
  }
}

/** Test-only. */
export function __resetOutboxForTests(): void {
  flushing.clear()
  flushListeners.clear()
  lanes.clear()
  outcomeListeners.clear()
}
