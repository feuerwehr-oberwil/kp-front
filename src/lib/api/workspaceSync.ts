// Per-incident sync engine: offline cache (IndexedDB) + debounced last-write-wins save with a
// three-way merge on conflict. Split out of the incidents data layer because it's the single
// heaviest, most stateful unit — see ./workspace for the plain get/put the engine drives.

/*
 * **409 re-merges wait a jittered moment** (`workspaceSync · conflictBackoffMs`: none before
 * the first merge, then 125–375 · 250–750 · 500–1500 ms) so three devices do not retry in
 * lock-step. ⚠️ An edit saved while a re-merge is in flight is built on the live view, which
 * has not seen that merge — the resolver re-bases it onto the merge before merging again
 * before putting the edit in its dirty cache, or the next attempt reads missing remote objects as local deletes
 * (the three-device load test lost 7–14 % of edits that way, `workspaceSync.load.test.ts`).
 * A network response belongs to the engine that sent it. Once that engine or its session
 * ends, its dirty cache is the handover copy; a late acknowledgement or denial must leave
 * the new engine’s cache, view and retry state alone.
 */
import { ApiError, isDenial, isUnverifiable } from '../api'
import { idbDel, idbGet, idbKeys, idbRead, idbSet, idbUpdate, type IdbRead } from '../idb'
import { serverNow } from '../serverClock'
import { withTileEviction } from '../tileEvict'
import { jsonEqual } from '../jsonEqual'
import { newId } from '../ids'
import { MERGE_POLICY, mergeWorkspace, type RecordConflict } from '../mergeWorkspace'
import { crewFiledOf, unionCrewFiled } from '../crewFiling'
import { truppRenumberings, type NumberScope, type TruppRenumbering } from '../truppNumbers'
import {
  getWorkspace, putWorkspace, putWorkspaceRecord, putWorkspaceRecordBeacon, putWorkspaceTrupps, putWorkspaceTruppsBeacon,
  type Workspace,
} from './workspace'
import type { Trupp } from '../../types'
import { isIncidentClosedRefusal, refusalClosedAt, reportIncidentClosed } from '../incidentClosed'
import { isOlderBuildRefusal } from '../olderBuild'

// --- Workspace sync: offline cache + debounced save with three-way merge -------------
// `base` is the last server revision we shared with everyone else — the common ancestor a
// conflict merges against (see mergeWorkspace). It rides the cache so an offline edit still
// has an ancestor to merge from on reconnect.
type CacheEntry = {
  workspace: Workspace
  baseRev: number
  dirty: boolean
  lastSyncedAt: number | null
  base?: Workspace
  /** WHO this entry belongs to (AuthUser.id), captured when the entry was BUILT or last edited —
   *  never re-stamped from the live session at write time, so a debounced/teardown write that
   *  lands after the identity changed still says whose work it is. An entry without one predates
   *  ownership (see `loadReadableEntry` for how it is adopted or preserved). */
  owner?: string
  /** When the newest edit in `workspace` was made, on the server-aligned clock (lib/serverClock)
   *  — sent as `edited_at`, so a closed Einsatz takes a save made before its close. */
  editedAt?: number
  /** Refused entries already transferred into this workspace. Stored with the replacement
   *  so a crash before clearing the refused slot cannot replay them over later edits. */
  requeuedRefused?: (number | string)[]
  /** Which engine authored this snapshot; its own retirement copy supersedes its earlier writes. */
  cacheWriter?: string
  /** Receipt of a recovery committed to the main slot by an earlier build. */
  quotaReceipt?: string
  /** Which push shape made its edits: the whole document (`'all'`) or a slice. A slice session
   *  that opens unsynced work of a WIDER shape parks a copy first (see `parkForRole`). Absent on
   *  entries written before 22.10.2026 — read as «unknown», never parked. */
  shape?: 'all' | Slice
}
const cacheKey = (id: string) => `kp-front-ws-${id}`
// A fallback slot, one per (incident, owner). Another user's UNSYNCED work is parked here so the
// main slot can be reused without destroying it, and so its owner recovers it on their next
// sign-in (see loadReadableEntry). NEVER read across owners — the key IS the ownership proof.
const ownerCacheKey = (id: string, owner: string) => `kp-front-ws-${id}::${owner}`
// One exceptional final draft per incident and author, distinct from the shared main slot and
// routine owner parking. Another tab may already be editing either while map tiles are evicted.
const quotaPrefix = '__quota__:'
const quotaKey = (id: string, owner: string | undefined) => ownerCacheKey(id, quotaPrefix + (owner ?? ''))
type QuotaDraft = CacheEntry & {
  quotaId: string
  /** A dirty snapshot this editor opened and has not yet replaced with a durable write of
   *  its own. Its final save supersedes that snapshot, including deletion of local-only rows. */
  inherited?: Workspace
  /** Main/parked snapshot the recovering editor actually saw before making its own edits. */
  observedMain?: Workspace
}
type QuotaRecovery = { key: string; source: QuotaDraft; localView: Workspace; observedMain?: Workspace }
// The orphan slot: unsynced work that carries NO owner — every entry written before ownership
// existed (this batch), when an online upgrade would otherwise let a clean server fetch overwrite
// the only unsynced copy. It is unattributable, so it is NEVER served (we can't prove who wrote
// it), but it is also never destroyed: it is parked here before the slot is reused, and recovered
// by hand from this key (there is deliberately no auto-restore — see loadReadableEntry). First
// writer wins, so an already-parked orphan (the real pre-upgrade copy) is never clobbered.
const orphanCacheKey = (id: string) => `kp-front-ws-${id}::__preupgrade__`
// The REFUSED slot (N3, 25.09.2026): saves the server turned down because the Einsatz had been
// closed by then — a Kontakt tapped on a device that had not heard yet, a Tafel edit queued
// offline. Not owed (no retry can deliver them while the Einsatz stays closed), never dropped:
// kept here as a list, newest last, and carried by «Einträge sichern» (refusedRecoveryData).
const refusedCacheKey = (id: string) => `kp-front-ws-${id}::__refused__`
const refusedOwnerPrefix = (key: string, owner: string) => `${key}:owner:${encodeURIComponent(owner)}:`

// The ROLE slot (RBAC audit S4, 22.10.2026): unsynced work a session of a wider role left on this
// device — an editor demoted to `el` mid-Einsatz, signed out by the role change, signs in again
// and its Lage edits are still in the cache. The `el`'s record slice cannot carry them, and the
// next adopt would have dropped them silently. A copy is parked here, per owner, for «Einträge
// sichern»; the record part still goes up as before. Same shape as the refused slot.
const roleCacheKey = (id: string, owner: string) => `kp-front-ws-${id}::__role__:${owner}`

/** One Einsatz's unsent workspace edits on this device and whose they are. */
export interface UnsentWorkspace {
  /** AuthUser.id of the account that made the edits */
  owner: string
  incidentId: string
  /** when the newest edit was made (server-aligned clock); 0 on an entry from before the stamp */
  editedAt: number
}

/**
 * Every owner-stamped, unsynced workspace entry this device holds: the main slots (a session that
 * was refused or signed out leaves its work there), owner parking and terminal quota recoveries. For the login
 * screen, which has no engine to ask and must say WHOSE work is waiting (sweep 09.11.2026, UX.2).
 * It reports who and when, never what: the blobs stay under their keys, untouched. The orphan,
 * refused and role slots are not listed (no sign-in sends them). An unreadable store or slot
 * lists nothing — the answer only informs, it never decides anything.
 */
export async function unsentWorkspaces(): Promise<UnsentWorkspace[]> {
  const prefix = cacheKey('')
  const keys = await idbKeys(prefix)
  if (!keys.ok) return []
  const found = await Promise.all((keys.value ?? []).map(async (key): Promise<UnsentWorkspace | null> => {
    const [incidentId, slot] = key.slice(prefix.length).split('::')
    if (!incidentId || (slot?.startsWith('__') && !slot.startsWith(quotaPrefix))) return null
    const read = await idbRead<CacheEntry>(key)
    const entry = read.ok ? read.value : null
    if (!entry?.dirty || !entry.owner) return null
    return { owner: entry.owner, incidentId, editedAt: entry.editedAt ?? 0 }
  }))
  return found.filter((u) => u !== null)
}

/** One save the server refused because the Einsatz was closed — the blob as this device had it. */
export interface RefusedWorkspace {
  /** Older entries carried only refusedAt; new entries have their own immutable storage key. */
  id?: string
  shape?: CacheEntry['shape']
  workspace: Workspace
  /** the ancestor it was built on — what a reopen merges it against (requeueRefused) */
  base?: Workspace
  baseRev: number
  refusedAt: number
  owner?: string
}

// --- Who may read this device's offline cache ----------------------------------------
// The cache is the product's core promise, so exactly two things close it, and NEITHER of them
// is a lost connection: a session a reachable server has explicitly refused (SEC-10 — a revoked
// or signed-out login must not keep reading the device's copy), and a cache another user filled.
// Silence — airplane mode, a restarting server — refuses nothing and still reads.
//
// Device state, not per-instance: one engine exists per open incident, but the answer is about
// the browser session. lib/auth is the only writer, because it is the only place that knows.
let cacheOwner: string | null = null
let cacheDenied = false
let ownerEpoch = 0
// Only engines with an armed disk write register. Start those writes before the incoming
// engine reads the shared slot to park its predecessor's work (including the last keystroke).
const pendingCacheWrites = new Set<() => Promise<boolean>>()

/** The signed-in user settled (boot probe, login, logout). A real user id also LIFTS a denial —
 *  the account is back, and the edits it left behind are its own again; `null` only drops
 *  ownership, so a logout keeps the lock it set. */
export function setWorkspaceCacheOwner(userId: string | null): void {
  if (userId !== cacheOwner) {
    for (const flush of pendingCacheWrites) void flush()
    ownerEpoch++
  }
  cacheOwner = userId
  if (userId) cacheDenied = false
}

/** A reachable server explicitly refused this session (401 / logout). Cached workspaces stop
 *  being readable at once. Nothing is deleted: unsynced edits stay on the device and are handed
 *  back the moment the same user signs in — writing is never locked, only reading. */
export function denyWorkspaceCache(): void {
  cacheDenied = true
}

/** May this session be answered from what the cache holds, as-is? A refusal closes every read.
 *
 *  The two guarantees this balances: offline-first (a device reopened with no reachable server
 *  must still show its own last work) and cross-user isolation (a DIFFERENT signed-in user must
 *  never read or inherit another's cache). They only ever collide once a competing identity
 *  exists — so ownership gates reads ONLY when an owner has actually settled:
 *    · denied            → false. A reachable server said «no»; this is the SEC-10 lock.
 *    · no settled owner  → true. Boot before /me resolves, or offline where it can't: there is
 *                          no other identity to protect against, so the device reads its own
 *                          cache (auth gates the moment a user — the same or a different one —
 *                          settles). Physical-device access with no login is the accepted
 *                          "device loss is operational" boundary, unchanged from before the batch.
 *    · owner settled     → an ownerless entry is NOT blind-served (loadReadableEntry adopts it if
 *                          clean, preserves it if dirty); an owned entry is served only to its
 *                          owner. */
function mayRead(entry: CacheEntry): boolean {
  if (cacheDenied) return false
  if (!cacheOwner) return true
  if (!entry.owner) return false
  return entry.owner === cacheOwner
}

/** how long after the last save() the offline cache write waits for the next one */
export const CACHE_DEBOUNCE_MS = 300
/** how often a main slot init() could not read is read again, whether or not anything is saved */
export const SLOT_PROBE_MS = 8_000

/** How many times one conflict is re-merged and re-pushed before the flush gives up to the
 *  ordinary retry backoff (which re-enters the resolver with a fresh budget). */
export const CONFLICT_ATTEMPTS = 4
/** Base of the wait before a RE-merge after a second 409 (24.09.2026). */
export const CONFLICT_BACKOFF_MS = 250

/**
 * The wait before re-merge attempt `attempt` (1-based: the first merge after the original 409
 * is attempt 0 and never waits). Exponential with FULL-RANGE jitter: base·2^(attempt−1) scaled
 * by a factor in [0.5, 1.5) — attempt 1 waits 125–375 ms, 2 250–750 ms, 3 500–1500 ms.
 *
 * ⚠️ Why (post-mortem 23.09.2026, D4): one editor login on three devices produced 140 409s in
 * ~40 minutes. Each device answered its 409 with an immediate GET + merge + PUT, up to four
 * times, so the three raced each other in lock-step — whoever lost once was likely to lose
 * again at the same instant. The merge was always right (revs 1–574 contiguous); only the
 * retry timing was not. A random pause breaks the lock-step; it changes nothing about WHAT is
 * merged. `random` is injectable for the bounds test.
 */
export function conflictBackoffMs(attempt: number, random: () => number = Math.random): number {
  if (attempt <= 0) return 0
  return Math.round(CONFLICT_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + random()))
}

// Same-document opens wait for their predecessor's actual disk attempt (including eviction).
// A different tab may already be open and writing: retired retries use the author's quotaKey.
const writingCache = new Map<string, Set<Promise<boolean>>>()

async function readCache(id: string): Promise<IdbRead<CacheEntry>> {
  const writes = writingCache.get(id)
  if (writes) await Promise.all(writes)
  return idbRead<CacheEntry>(cacheKey(id))
}

/** Serialize recovery reads by active tabs. Writes use atomic IndexedDB updates. Never hold
 *  this lock during network I/O or tile eviction. Older browsers can read without it. */
async function withQuotaSlot<T>(key: string, action: () => Promise<T>, unavailable: () => T): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return action()
  let granted = false
  try {
    return await navigator.locks.request('kp-front-recovery-' + key, () => {
      granted = true
      return action()
    })
  } catch (error) {
    if (granted) throw error
    return unavailable() // an inactive document can be refused before grant
  }
}

/** Reconcile independently authored dirty records; the newer editor wins a same-field conflict.
 *  Use the older server ancestor so later server additions survive. Keep a wider role's shape
 *  intact until open() can park it before a restricted session writes. */
function combineDrafts(first: CacheEntry, second: CacheEntry, sharedBase?: Workspace): CacheEntry {
  const ancestor = first.baseRev <= second.baseRev ? first : second
  const server = first.baseRev > second.baseRev ? first : second
  const shape = first.dirty && second.dirty && first.shape !== second.shape ? 'all' : (second.shape ?? first.shape)
  const workspace = mergeWorkspace(sharedBase ?? ancestor.base ?? {}, second.workspace, first.workspace,
    undefined, undefined, { numbers: shape === 'record' ? 'off' : shape === 'trupps' ? 'trupps' : 'all' })
  return { ...second, workspace, base: server.base, baseRev: server.baseRev, dirty: true, shape,
    editedAt: Math.max(first.editedAt ?? 0, second.editedAt ?? 0) || undefined,
    requeuedRefused: [...new Set([...(first.requeuedRefused ?? []), ...(second.requeuedRefused ?? [])])] }
}

// NOTE: the per-instance writer is `this.writeCache` below — it keeps the durability of each
// write, which a bare fire-and-forget threw away. "Non-fatal because the server is authoritative"
// holds only while we ARE reaching the server; offline it is the difference between an edit that
// survives teardown and one that doesn't.

/** Drop one incident's offline cache. DESTRUCTIVE: any edit that hasn't reached the server yet
 *  lives only here. The single caller is the ErrorBoundary's last-resort recovery — when the
 *  cached blob is what crashes the render, this is the only way back in from the device itself
 *  (the next open re-pulls from the server). */
export function discardWorkspaceCache(id: string): Promise<void> {
  return idbDel(cacheKey(id))
}

/** Lifecycle of the per-incident sync, surfaced to the UI so unsynced/offline/error
 *  states are never silent: `synced` = server has our latest; `pending` = local edits
 *  not yet flushed; `offline` = a flush failed on the network (cached locally, will
 *  retry); `error` = a flush failed for another reason (also cached, also retried);
 *  `storage` = the offline cache itself refused the write, so unsynced edits are NOT
 *  "cached locally, will retry" — they live only in this tab. See effectiveSyncStatus. */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error' | 'storage'

/**
 * Collapse the sync lifecycle and the durability of the local cache into the one state the UI
 * shows. `storage` outranks everything else, but ONLY while there are unsynced edits.
 *
 * That condition is the whole point. Every other status quietly promises "your work is cached
 * and will be retried" — a promise a full storage bucket breaks, turning "will sync later" into
 * "will be lost on teardown", which the operator must see. But when the server already has our
 * latest, a cache that can't write costs nothing right now; it only means this device is not
 * offline-READY. Shouting then would be crying wolf, and the Offline-Bereitschaft sheet is the
 * honest place for it (it reports device readiness, which is exactly what's degraded).
 */
export function effectiveSyncStatus(base: SyncStatus, dirty: boolean, cacheDurable: boolean): SyncStatus {
  return !cacheDurable && dirty ? 'storage' : base
}

export interface WorkspaceSyncOptions {
  /** called whenever the synced revision changes (e.g. to update UI badges). */
  onRev?: (rev: number) => void
  /** called with the authoritative workspace when it must replace local state out-of-band
   *  (fallback when no in-place applier is registered — triggers a full remount). */
  onServerWorkspace?: (ws: Workspace, rev: number) => void
  /** called after a 409 was auto-merged, so the app can show a non-blocking notice. */
  onMerged?: () => void
  debounceMs?: number
  /**
   * Push only ONE slice of the blob instead of the whole document.
   *
   * `'trupps'` is the Atemschutz-Link session (auth · AuthUser.link_kind): it may write the
   * Überwachungstafel and nothing else, so the full workspace PUT 403s for it. `'record'`
   * (07.09.2026) is the `el` role's slice the same way: the operational record — Anwesenheit/
   * Zeitplan, Mittel, Checklisten, Rapport + Beilagen — on its own route. Only the push
   * and the teardown beacon change — the cache, the debounce, the three-way merge on 409, the
   * retry backoff and the live-follow poll are the same engine, because the merge still has to
   * reason about the WHOLE blob (the server's copy carries everything).
   */
  slice?: 'trupps' | 'record'
}

/** The trupp slice of an opaque workspace blob. The engine treats the blob as data it only
 *  moves, so this (and recordSlice below) is the one place that looks inside it — absent or
 *  malformed reads as «no Trupps», which is what a fresh Einsatz genuinely has. */
function truppSlice(ws: Workspace): readonly Trupp[] {
  const t = ws.trupps
  return Array.isArray(t) ? (t as Trupp[]) : []
}

/**
 * Is `ws` the server's copy `base` with only its Trupps changed? Then an EDITOR's push takes the
 * trupp slice route too (18.10.2026): a Funkkontakt changes one Trupp, and the full PUT sent the
 * whole blob for it — ~100 KB of JSON (~38 KB gzipped) per tap on the busiest Einsatz on record,
 * nine taps ~345 KB (perf journey `trupps`), on the device a crew holds while it talks on the radio.
 *
 * Equivalent, not a new kind of save: the route stores `{...the server's blob at base_rev,
 * trupps}` under the same conditional UPDATE, so at that revision the result IS `ws` — what the
 * server keeps of its own on a full save (the vehicles' gps, newer board kinds) it keeps here
 * too. Same 409 (and the same merge), same closed-Einsatz rule (a Trupp edit is operational
 * either way), same validation, same audit and Notfall push. `base` is the ancestor the engine
 * holds for exactly `baseRev` — no ancestor (an old cache entry) ⇒ the full PUT, as always.
 */
function onlyTruppsChanged(base: Workspace | undefined, ws: Workspace): boolean {
  if (!base || !Array.isArray(ws.trupps) || jsonEqual(base.trupps, ws.trupps)) return false
  for (const k of new Set([...Object.keys(base), ...Object.keys(ws)])) {
    if (k !== 'trupps' && !jsonEqual(base[k], ws[k])) return false
  }
  return true
}

/** The keys of the `el` role's record slice — MUST mirror the server's allowlist
 *  (backend api/incidents · RECORD_WORKSPACE_KEYS); anything else would be silently dropped
 *  there, so sending it would only fake a successful save. Absent keys mean «no change». */
const RECORD_SLICE_KEYS = ['attendance', 'shifts', 'bands', 'mittel', 'checklists', 'reportMeta', 'attachments', 'reportSignatures'] as const

/** The crew filing's markers riding the record slice (22.10.2026, RBAC audit S4) — mirrors the
 *  server's `RECORD_CREW_FILED_KEY`. `trupps[].crewFiled` says whom the ANWESENHEIT was told
 *  about (lib/crewFiling): a record fact the `el` files, stored on the Trupps it cannot write.
 *  Sent as `{ truppId: keys }`; the server UNIONS them onto its own Trupps and reads nothing else,
 *  so an el phone beside an Atemschutz-Link (no FU tablet) files a crew once, and a member the el
 *  took off the Anwesenheit stays off. */
const CREW_FILED_SLICE_KEY = 'truppCrewFiled'

function crewFiledMarks(ws: Workspace): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {}
  for (const t of truppSlice(ws)) {
    const keys = crewFiledOf(t)
    if (typeof t?.id === 'string' && keys.length) out[t.id] = keys
  }
  return Object.keys(out).length ? out : undefined
}

/** The `schemaVersion` the blob was stamped with — sent with a slice (api/workspace). */
const versionOf = (ws: Workspace): number | undefined => (typeof ws.schemaVersion === 'number' ? ws.schemaVersion : undefined)

function recordSlice(ws: Workspace): Workspace {
  const out: Workspace = {}
  for (const k of RECORD_SLICE_KEYS) if (k in ws) out[k] = ws[k]
  const marks = crewFiledMarks(ws)
  if (marks) out[CREW_FILED_SLICE_KEY] = marks
  return out
}

type Slice = NonNullable<WorkspaceSyncOptions['slice']>

/**
 * The server's blob once it took a slice push of `local`: `server` (its copy at the base revision)
 * with the slice's keys replaced — exactly what `PUT …/workspace/trupps` and `…/record` store
 * (backend api/incidents). The `el`'s crew markers are unioned onto the server's own Trupps.
 *
 * ⚠️ NOT `local` (RBAC audit S4, 22.10.2026): the engine used to take the whole pushed blob as the
 * new ancestor, so whatever this session holds OUTSIDE its slice counted as «on the server» —
 * the Trupps' crew markers an el filed, and every unsynced edit a session left behind when its
 * role changed — and the next adopt dropped it without a word.
 */
function landedSlice(server: Workspace, local: Workspace, slice: Slice): Workspace {
  if (slice === 'trupps') return { ...server, trupps: truppSlice(local) }
  const { [CREW_FILED_SLICE_KEY]: _marks, ...record } = recordSlice(local)
  const out: Workspace = { ...server, ...record }
  const marks = crewFiledMarks(local)
  if (marks && Array.isArray(server.trupps)) {
    out.trupps = (server.trupps as Trupp[]).map((t) => {
      const add = typeof t?.id === 'string' ? marks[t.id] : undefined
      if (!add) return t
      const before = crewFiledOf(t)
      const merged = unionCrewFiled(before, add)!
      return merged.length === before.length ? t : { ...t, crewFiled: merged }
    })
  }
  return out
}

/** The `'local'` rows of MERGE_POLICY — this device's own view state, kept by every merge. */
const LOCAL_KEYS = (Object.entries(MERGE_POLICY) as [string, unknown][]).filter(([, p]) => p === 'local').map(([k]) => k)

/**
 * A slice session's merge result: the server's copy (`theirs`) for everything the session cannot
 * push, the merged slice, and this device's own view keys. A local difference outside the slice
 * can never reach the server; kept by the merge (last-writer-wins «mine»), it showed a picture no
 * other device has — and claimed it as the ancestor on the next push (RBAC audit S4).
 */
function sliceMerged(merged: Workspace, theirs: Workspace, slice: Slice): Workspace {
  const out = landedSlice(theirs, merged, slice)
  for (const k of LOCAL_KEYS) {
    if (k in merged) out[k] = merged[k]
    else delete out[k]
  }
  return out
}

/**
 * Per-incident sync engine. The App calls `save(workspace)` on every edit (replacing the
 * old direct localStorage write); we cache instantly, mark dirty, and flush to the server
 * debounced. `init()` loads from server (falling back to the offline cache).
 */
export class WorkspaceSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** the offline-cache write waiting for the keystrokes to stop — see writeCache */
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  private entry: CacheEntry
  private flushing: Promise<void> | null = null
  /** somebody asked for a flush while one was in flight — see `flush` */
  private flushRequested = false
  /** the last attempt failed because the server could not be ASKED (api · isUnverifiable) */
  private unreached = false
  private disposed = false
  private saveSeq = 0 // bumped on each save(); lets a flush detect an edit that landed mid-PUT
  private readonly debounceMs: number
  // Automatic retry after a FAILED flush (server 5xx / network drop): without it a dirty
  // workspace on an idle device stays unsynced forever — the live-poll gates on !hasUnsynced,
  // so it stops pulling too — until the operator happens to edit again. Exponential backoff,
  // reset on any successful push.
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  /** Registered by the live view to apply a merged/authoritative workspace IN PLACE (no
   *  remount), so an auto-merged conflict surfaces the other device's edits smoothly. Falls
   *  back to onServerWorkspace (a remount) when unset. */
  onApplyMerged?: (ws: Workspace, rev: number) => void
  /** This engine's id on every save it makes and on its live follow (api/workspace ·
   *  pollWorkspaceSince): the server answers a range of revisions that is nothing but this
   *  engine's own saves without the blob, instead of handing back what was just sent.
   *  Per ENGINE, not per login or tab: one login runs on three tablets, and only the engine whose
   *  state holds a save may call it its own. ⚠️ A collision would make another device's save
   *  look like this one's — so newId's family plus 8 more random characters (~10¹² apart). */
  readonly writerId = `${newId('ws')}${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`
  /** Registered by the live view to reflect the sync lifecycle in the UI (status badge).
   *  Set after construction (like onApplyMerged); read the initial value via `syncStatus`. */
  onStatus?: (status: SyncStatus) => void
  /** Registered by the live view (useIncidentSync): a three-way merge saw BOTH sides change
   *  the SAME person's attendance to different values (LWW kept) — the caller appends one
   *  Verlauf note per person. Conflicts found before registration (init()'s cold-reopen
   *  merge) buffer until the first registration/drain. */
  onAttendanceConflicts?: (conflicts: RecordConflict[]) => void
  private conflictBuf: RecordConflict[] = []
  /** Registered by the live view (useIncidentSync): a three-way merge saw BOTH sides change
   *  the SAME Trupp concurrently. The merge itself is field-level (mergeWorkspace · mergeTrupp
   *  — nothing was dropped), but two devices writing one SCBA crew's record at once gets a
   *  Verlauf note so a human checks. Buffers like the attendance channel until registration. */
  onTruppConflicts?: (conflicts: RecordConflict[]) => void
  private truppConflictBuf: RecordConflict[] = []
  /** a Tafel page two devices wrote on at once, a cell both changed (lib/boardFormMerge) */
  onFormConflicts?: (conflicts: RecordConflict[]) => void
  private formConflictBuf: RecordConflict[] = []
  /** Registered by the live view (useIncidentSync): a Trupp or loose «Trupp N» chip changed its
   *  number — a merge settled a number two devices minted at once (lib/truppNumbers). The caller
   *  writes the ONE Verlauf row, under an id derived from the change, so every report of the same
   *  change is the same row. Reported (see `reportRenumbered`) for what the view showed against
   *  what it is handed, and — by the device whose merge made the change — for what the server
   *  held against what that device pushed. Buffers until registration like the conflict
   *  channels, keyed by the change, so a session nobody listens to holds each change once. */
  onTruppRenumbered?: (changes: TruppRenumbering[]) => void
  private renumberBuf = new Map<string, TruppRenumbering>()
  /** The last state the VIEW holds: what it last saved, or what it was last handed (init, a
   *  merge applied in place, an adopted revision). A renumbering is said against this as well as
   *  against the content that 409'd — a Trupp registered while a merge was in flight exists in
   *  neither the content that 409'd nor the server copy, only here. */
  private viewState: Workspace = {}
  /** While a conflict PUT is pending the view still edits its pre-merge snapshot, but the
   *  cache already has the newer server ancestor. Rebase each save from the view as it was
   *  at this merge onto its union, including when the request never returns to this owner. */
  private pendingViewMerge: { view: Workspace; merged: Workspace } | null = null
  /** the lifecycle state on its own, before the cache-durability overlay (effectiveSyncStatus) */
  private base: SyncStatus
  /** what the UI last saw — the overlaid value */
  private status: SyncStatus
  /** did the most recent offline-cache write actually land? Per-incident on purpose: the global
   *  isStorageDegraded() flag also moves for unrelated keys (config, roster), which would make
   *  this incident's badge flap. */
  private cacheDurable = true
  private inheritedDirty?: Workspace
  /** A quota recovery could not be checked during open; the next open checks it again. */
  private quotaDeferred = false
  /** The main cache slot holds ANOTHER session's unsynced dirty work that init() could NOT copy
   *  to a durable parking slot (a full store). That copy is the only one, so this session must
   *  never overwrite the slot — writeCache/flushCache no-op here and report the cache as
   *  non-durable instead. Cleared only by a reload (a fresh init re-attempts the park once the
   *  storage pressure has cleared). See init / serveServerWithoutCaching. */
  private mainSlotBlocked = false
  /** init() could not READ the main slot (a failed IndexedDB read, not a miss). What it holds is
   *  unknown — possibly this device's only copy of unsynced offline edits — so the slot is blocked
   *  exactly like an un-parkable foreign entry (mainSlotBlocked). Unlike that case the block is
   *  re-probed on the next cache write: once a read answers and the slot holds nothing unsynced,
   *  it lifts and the cache is written again. See probeUnreadSlot. */
  private slotUnread = false
  private probing = false
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  /** Saves refused because the Einsatz is closed (see refusedCacheKey) — read at init(), kept in
   *  step with the slot. Parked, not pending: they are not part of the sync status. */
  private refused: RefusedWorkspace[] = []
  // Shared pre-upgrade slots can contain several people's edits. Keep all of them on disk,
  // but export and replay only edits made by the account that still owns this engine.
  private readonly sessionOwner = cacheOwner
  private readonly sessionEpoch = ownerEpoch
  private get ownsCache(): boolean {
    return !this.disposed && this.sessionEpoch === ownerEpoch
  }
  /** An init from a previous selection may finish after this slot has a new owner.
   *  Cancel before another write, callback or offline fallback can act on that selection. */
  private requireOpeningOwner(): void {
    if (!this.ownsCache) throw new Error('Incident selection cancelled')
  }
  private get sessionActive(): boolean {
    return this.ownsCache && !cacheDenied
  }
  private ownRefused(disposition: 'replay' | 'role' = 'replay'): RefusedWorkspace[] {
    if (!this.sessionActive || !this.sessionOwner) return []
    return this.refused.filter((item) => {
      const outsideSlice = !!this.opts.slice && item.shape !== this.opts.slice
      return item.owner === this.sessionOwner && outsideSlice === (disposition === 'role')
    })
  }
  /** Who wants to hear that the refused count changed (a save was just parked, or the slot held
   *  some from an earlier session) — see `subscribeRefused`. */
  private refusedListeners = new Set<(count: number) => void>()
  /** Work of a wider role parked on this device (see roleCacheKey) — this owner's, for the count
   *  and «Einträge sichern». Not owed: no push of this session can deliver it. */
  private roleParked: RefusedWorkspace[] = []
  private roleParkedListeners = new Set<(count: number) => void>()
  /** Who wants to hear which OTHER accounts have unsent work for this Einsatz parked on this
   *  device — see `subscribeForeignParked`. */
  private foreignParkedListeners = new Set<(owners: string[]) => void>()

  constructor(
    readonly incidentId: string,
    private readonly opts: WorkspaceSyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000
    // The cache lives in IndexedDB (async), so it can't be read in the constructor; init()
    // loads it before the first edit. Start empty/synced until then.
    // …stamped with the session that opened this incident, so a teardown write that lands AFTER
    // that session ended (a denial unmounts the app) still says whose work it is.
    this.entry = { workspace: {}, baseRev: 0, dirty: false, lastSyncedAt: null, owner: cacheOwner ?? undefined }
    this.base = 'synced'
    this.status = 'synced'
  }

  /** Record the lifecycle state, then publish whatever the overlay makes of it. */
  private setStatus(s: SyncStatus) {
    this.base = s
    this.publish()
  }

  /** Fire onStatus only on a real transition (de-dupes repeated saves while pending). */
  private publish() {
    // ⚠️ An unread slot may hold this device's only copy of unsynced offline edits, which nothing
    // in this session has merged or pushed: «synced» would be a promise nobody can keep yet.
    const eff = this.slotUnread || this.quotaDeferred ? 'storage' : effectiveSyncStatus(this.base, this.entry.dirty, this.cacheDurable)
    if (this.status === eff) return
    this.status = eff
    this.onStatus?.(eff)
  }

  /** Cache one revision for reload/offline, KEEPING whether it was durable. A refused write means
   *  any unsynced edit in it exists only in this tab, which `publish` turns into 'storage'.
   *  A full device evicts map tiles and retries first — the incident record outranks scenery.
   *
   *  Trailing-debounced (CACHE_DEBOUNCE_MS): several surfaces save per keystroke, and each write
   *  is a structured clone + IDB put of the WHOLE blob — on a full device also a tile eviction
   *  per key, which destroyed the prefetched map area while a Bemerkung was being typed. Only the
   *  latest entry matters, so a burst lands once. Every path that must not lose the write flushes
   *  synchronously first: teardown, an owner change and the server push (the cache ancestor
   *  has to be the one we pushed). */
  private writeCache() {
    if (!this.ownsCache) return
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = setTimeout(this.flushCache, CACHE_DEBOUNCE_MS)
    pendingCacheWrites.add(this.flushCache)
  }

  /** Write the current entry to the offline cache NOW (a no-op when nothing is waiting). */
  private cacheWrite: Promise<boolean> = Promise.resolve(true)
  private retiredWrite: Promise<boolean> | null = null
  private quotaRecovery: QuotaRecovery | null = null
  private flushCache = (): Promise<boolean> => {
    if (!this.cacheTimer) return this.cacheWrite
    clearTimeout(this.cacheTimer)
    this.cacheTimer = null
    pendingCacheWrites.delete(this.flushCache)
    // The main slot is holding another session's un-parked unsynced work (see
    // serveServerWithoutCaching). Writing our state over it would destroy the only copy, so this
    // session stays in memory only and reports the cache as non-durable — nothing is written here.
    if (this.mainSlotBlocked) {
      if (!this.disposed && this.cacheDurable) { this.cacheDurable = false; this.publish() }
      if (this.slotUnread) void this.probeUnreadSlot()
      return Promise.resolve(false)
    }
    if (!this.ownsCache) return Promise.resolve(false)
    const key = cacheKey(this.incidentId)
    const writes = writingCache.get(this.incidentId) ?? new Set<Promise<boolean>>()
    writingCache.set(this.incidentId, writes)
    const write = withTileEviction(async () => {
      const entry = { ...this.entry, cacheWriter: this.writerId }
      if (this.quotaRecovery) return this.writeQuotaRecovery(this.quotaRecovery, entry)
      if (this.ownsCache) return idbSet(key, entry)
      if (!entry.dirty) return false
      // Another engine, even another tab, may now own the main slot. Keep the last authored
      // dirty snapshot separately until its author opens this incident again.
      if (this.retiredWrite) return this.retiredWrite
      const rescue = quotaKey(this.incidentId, entry.owner)
      this.retiredWrite = idbUpdate<QuotaDraft>(rescue, (previous) => {
        const independent = previous?.quotaId && previous.cacheWriter !== entry.cacheWriter &&
          !jsonEqual(previous.workspace, this.inheritedDirty)
        const draft = independent ? combineDrafts(previous, entry) : entry
        return { ...draft, quotaId: this.writerId, inherited: this.inheritedDirty }
      }).then((stored) => {
        if (!stored) this.retiredWrite = null
        return stored
      })
      return this.retiredWrite
    })
    writes.add(write)
    this.cacheWrite = write.finally(() => {
      writes.delete(write)
      if (!writes.size) writingCache.delete(this.incidentId)
    }).then((ok) => {
      if (ok && this.ownsCache) this.inheritedDirty = undefined
      if (this.ownsCache && this.cacheDurable !== ok) {
        this.cacheDurable = ok
        this.publish()
      }
      return ok
    })
    return this.cacheWrite
  }

  /** Try the main slot init() could not read once more — on the next blocked cache write, and
   *  every SLOT_PROBE_MS on its own, so a session that saves nothing still finds out.
   *  Missing or clean (the server has it) ⇒ lift the block and write the cache again.
   *  Unsynced and MINE ⇒ merge it into this session the way init() merges a cold reopen, then
   *  lift the block: the entry now carries that work, and the next flush pushes it (24.09.2026 —
   *  it used to sit in the slot until a reload, neither merged nor pushed, under a green badge).
   *  Unsynced and someone else's ⇒ park it for its owner first, durable-or-abort, as init() does. */
  private async probeUnreadSlot() {
    if (this.probing || !this.sessionActive) return
    this.probing = true
    try {
      const read = await readCache(this.incidentId)
      if (!this.sessionActive || !this.slotUnread) return
      if (!read.ok) { this.scheduleProbe(); return }
      const stored = read.value
      const readable = stored && mayRead(stored) ? stored : null
      if (stored?.dirty && !readable) {
        const durable = stored.owner
          ? await idbSet(ownerCacheKey(this.incidentId, stored.owner), stored)
          : await this.parkOrphan(stored)
        if (!this.sessionActive || !this.slotUnread) return
        void this.announceForeignParked()
        // the only copy stays where it is; this session carries on in memory, as after init()
        if (!durable) { this.slotUnread = false; this.publish(); return }
      }
      // The main slot is now safe. Finish the same quota and wider-role recovery as open().
      const recovered = (await this.restoreQuotaDraft(readable)) ?? readable
      if (!this.sessionActive || !this.slotUnread) return
      if (recovered?.dirty) {
        if (this.mustParkForRole(recovered) && !(await this.parkForRole(recovered))) { this.scheduleProbe(); return }
        if (!this.sessionActive || !this.slotUnread) return
        if (recovered.quotaReceipt) this.entry = { ...this.entry, quotaReceipt: recovered.quotaReceipt }
        this.mergeFoundSlot(recovered)
      }
      this.slotUnread = false
      this.mainSlotBlocked = false
      this.writeCache()
      this.publish()
    } catch {
      this.scheduleProbe() // cancellation on handover stops here; a live failed read can retry
    } finally {
      this.probing = false
    }
  }

  private scheduleProbe() {
    if (!this.sessionActive || !this.slotUnread || this.probeTimer) return
    this.probeTimer = setTimeout(() => { this.probeTimer = null; void this.probeUnreadSlot() }, SLOT_PROBE_MS)
  }

  /** The late answer to init()'s cold-reopen merge: the slot's own unsynced edits against their
   *  cached ancestor, merged over what this session holds now (the server copy plus anything
   *  edited since). The server ancestor and rev stay this session's, so the push goes at them. */
  private mergeFoundSlot(stored: CacheEntry) {
    const merged = this.mergeReporting(stored.base ?? {}, stored.workspace, this.entry.workspace)
    // both halves were written under their numbers: this session's view, and the slot's offline work
    this.reportRenumbered(this.viewState, merged)
    this.reportRenumbered(stored.workspace, merged)
    this.saveSeq++ // a push in flight carries the pre-merge state: it must not mark this clean
    this.entry = { ...this.entry, workspace: merged, dirty: true, owner: this.entry.owner ?? stored.owner ?? cacheOwner ?? undefined, shape: this.shape }
    this.handToView(merged, this.entry.baseRev)
    this.setStatus('pending')
    this.armDebounce()
  }

  /** mergeWorkspace with divergence reporting (attendance keys + concurrently edited Trupps):
   *  collected conflicts go to the registered listeners, or buffer until one registers (init
   *  runs before the view mounts). */
  private mergeReporting(base: Workspace, mine: Workspace, theirs: Workspace): Workspace {
    const conflicts: RecordConflict[] = []
    const truppConflicts: RecordConflict[] = []
    const formConflicts: RecordConflict[] = []
    const all = mergeWorkspace(base, mine, theirs, (c) => conflicts.push(c), (c) => truppConflicts.push(c),
      { numbers: this.numberScope, onFormConflict: (c) => formConflicts.push(c) })
    const merged = this.opts.slice ? sliceMerged(all, theirs, this.opts.slice) : all
    if (conflicts.length) {
      if (this.onAttendanceConflicts) this.onAttendanceConflicts(conflicts)
      else this.conflictBuf.push(...conflicts)
    }
    if (truppConflicts.length) {
      if (this.onTruppConflicts) this.onTruppConflicts(truppConflicts)
      else this.truppConflictBuf.push(...truppConflicts)
    }
    if (formConflicts.length) {
      if (this.onFormConflicts) this.onFormConflicts(formConflicts)
      else this.formConflictBuf.push(...formConflicts)
    }
    return merged
  }

  /** What this session's merges may settle (lib/truppNumbers · NumberScope): only what its push
   *  can carry. A slice that settled a number it cannot push would see the old one come back on
   *  the next poll — and say so, «1 → 2» and then «2 → 1». */
  private get numberScope(): NumberScope {
    return this.opts.slice === 'record' ? 'off' : this.opts.slice === 'trupps' ? 'trupps' : 'all'
  }

  /** The merge with this session's number scope — for the re-base merges that report nothing.
   *  A slice session keeps the server's copy of what it cannot push (sliceMerged). */
  private merge(base: Workspace, mine: Workspace, theirs: Workspace): Workspace {
    const merged = mergeWorkspace(base, mine, theirs, undefined, undefined, { numbers: this.numberScope })
    return this.opts.slice ? sliceMerged(merged, theirs, this.opts.slice) : merged
  }

  /** Hand a merged state to the live view (in place, else the remount fallback) and remember it
   *  as what the view now holds. */
  private handToView(ws: Workspace, rev: number) {
    this.pendingViewMerge = null
    this.viewState = ws
    if (this.onApplyMerged) this.onApplyMerged(ws, rev)
    else this.opts.onServerWorkspace?.(ws, rev)
  }

  /** Report what changed its Trupp number between `before` and `after` — see onTruppRenumbered.
   *  A diff rather than a report out of the merge itself: a merge whose PUT 409s is merged again
   *  and may settle differently, and only a state that reaches the view (or the server) is true.
   *  `adopt` marks a revision the live poll adopted — the ONE source a session that settles
   *  nothing itself (the `el` role's record slice) reports from: everything it merges it cannot
   *  push, so everything it could report from a merge would be its own guess. */
  private reportRenumbered(before: Workspace, after: Workspace, source: 'merge' | 'adopt' = 'merge') {
    if (source === 'merge' && this.numberScope === 'off') return
    const changes = truppRenumberings(before, after)
    if (!changes.length) return
    if (this.onTruppRenumbered) { this.onTruppRenumbered(changes); return }
    // nobody listening yet (init runs before the view mounts): hold each change ONCE, so a
    // session no listener ever registers on cannot grow this without bound
    for (const c of changes) this.renumberBuf.set(`${c.id}|${c.from}|${c.to}`, c)
  }

  /** Renumberings seen before a listener registered (init()'s cold-reopen merge). */
  drainTruppRenumbered(): TruppRenumbering[] {
    const buf = [...this.renumberBuf.values()]
    this.renumberBuf.clear()
    return buf
  }

  /** Conflicts reported before a listener registered (init()'s cold-reopen merge) — the
   *  live view drains them once on mount, then follows via onAttendanceConflicts. */
  drainAttendanceConflicts(): RecordConflict[] {
    const buf = this.conflictBuf
    this.conflictBuf = []
    return buf
  }

  /** Same drain for the Tafel-page channel (see onFormConflicts). */
  drainFormConflicts(): RecordConflict[] {
    const buf = this.formConflictBuf
    this.formConflictBuf = []
    return buf
  }

  /** Same drain for the Trupp channel (see onTruppConflicts). */
  drainTruppConflicts(): RecordConflict[] {
    const buf = this.truppConflictBuf
    this.truppConflictBuf = []
    return buf
  }

  /**
   * The whole owner model, in one place. Decide what the current session may load from the main
   * cache slot, and protect what it may not — so a DIFFERENT user can never inherit or destroy
   * another user's cached or unsynced work:
   *   · owned by me → mine, serve it (the fast, common path).
   *   · ownerless + clean → a pre-ownership snapshot (the server already has it). Adopt it to me,
   *     so the NEXT, different user can't read it, then serve it.
   *   · ownerless + dirty → unattributable unsynced work (written before owners existed). Park it
   *     under the orphan key, never serve it: I can't prove I'm its author. The park is what makes
   *     an ONLINE upgrade safe — without it, init()'s server fetch overwrites the only copy.
   *   · owned by someone else + dirty → their unsynced work. PARK it under their own key so I can
   *     reuse the main slot without destroying it (the SEC-10 regression: a plain reload used to
   *     clobber it), and they recover it on their next sign-in.
   *   · owned by someone else + clean → the server has it; leave it (the next write overwrites it).
   * The rule for the two dirty cases is one rule: an UNSERVED dirty entry must be preserved BEFORE
   * init() reuses its slot for a server fetch, whether it is foreign-owned or ownerless.
   * Then, whatever the main slot held, look for MY OWN parked work — a different user (or a
   * denial) may have taken the slot after I left — and re-home it. A denial closes all of this.
   *
   * `parkBlocked` is the durable-or-abort signal: a dirty entry we may not serve was found in the
   * main slot but could NOT be copied to a durable parking slot (a full store). Its slot must then
   * be left exactly as it is — it is the only copy — so init() must not overwrite it with the
   * server snapshot, and we skip the re-home below too (that also writes the main slot).
   */
  private async loadReadableEntry(stored: CacheEntry | null): Promise<{ entry: CacheEntry | null; parkBlocked: boolean }> {
    if (stored && mayRead(stored)) return { entry: stored, parkBlocked: false }
    if (stored && !cacheDenied) {
      if (!stored.owner && !stored.dirty && cacheOwner) {
        const adopted: CacheEntry = { ...stored, owner: cacheOwner }
        await idbSet(cacheKey(this.incidentId), adopted)
        return { entry: adopted, parkBlocked: false }
      }
      // An unserved DIRTY entry is about to have its slot reused by init()'s server fetch. Copy it
      // somewhere safe FIRST — the main slot is left as-is and only a real server answer overwrites
      // it, by which point the copy exists. DURABLE-OR-ABORT: if that copy is not durable (a full
      // store — which can still permit the smaller clean-snapshot write that would then destroy the
      // only copy), leave the slot untouched and abort the reuse (parkBlocked). Foreign-owned goes
      // to its owner's key; ownerless (pre-upgrade) goes to the orphan key. `stored.owner` here is
      // necessarily a DIFFERENT user — an entry owned by me would have been served by mayRead above.
      if (stored.dirty) {
        const durable = stored.owner
          ? await idbSet(ownerCacheKey(this.incidentId, stored.owner), stored)
          : await this.parkOrphan(stored)
        this.requireOpeningOwner()
        if (!durable) return { entry: null, parkBlocked: true }
      }
    }
    if (cacheOwner && !cacheDenied) {
      const rehomeOwner = cacheOwner
      const parkedKey = ownerCacheKey(this.incidentId, rehomeOwner)
      const parked = await idbGet<CacheEntry>(parkedKey)
      this.requireOpeningOwner()
      if (parked && parked.owner === rehomeOwner) {
        // The slot is mine again: re-home my work, then clear the bucket — but ONLY once the main
        // write is CONFIRMED durable. Deleting the parked copy after a failed write (a full store)
        // would be the exact data loss the parking exists to prevent, so on failure the sole copy
        // stays under the owner key for the next attempt.
        const wrote = await idbSet(cacheKey(this.incidentId), parked)
        this.requireOpeningOwner()
        if (wrote) await idbDel(parkedKey)
        return { entry: parked, parkBlocked: false }
      }
    }
    return { entry: null, parkBlocked: false }
  }

  /** An open starts before the UI acquires its editor lock. Treat the main slot as a live
   *  peer's data throughout recovery: read it after grant; keep this editor's changes under
   *  its author's quota key until the server accepts them. */
  private async restoreQuotaDraft(first: CacheEntry | null): Promise<CacheEntry | null> {
    if (!this.sessionActive) return null
    const owner = this.sessionOwner ?? first?.owner
    const key = quotaKey(this.incidentId, owner)
    const defer = () => { this.quotaDeferred = true; return null }
    const initial = await idbRead<QuotaDraft>(key)
    this.requireOpeningOwner()
    if (!initial.ok) return defer()
    if (!initial.value?.quotaId) return null
    return withQuotaSlot(key, async () => {
      this.requireOpeningOwner()
      const found = await idbRead<QuotaDraft>(key)
      this.requireOpeningOwner()
      if (!found.ok) return defer()
      if (!found.value?.quotaId) return null
      const { quotaId, inherited, observedMain, ...draft } = found.value
      if (draft.owner !== owner || !mayRead(draft)) return null
      const current = await readCache(this.incidentId)
      this.requireOpeningOwner()
      if (!current.ok) return defer()
      let peer = current.value
      if (peer?.owner !== owner || !peer) {
        const parked = owner ? await idbRead<CacheEntry>(ownerCacheKey(this.incidentId, owner)) : null
        this.requireOpeningOwner()
        if (parked && !parked.ok) return defer()
        peer = parked?.value?.owner === owner ? parked?.value ?? null : null
      }
      let entry = draft
      if (peer?.quotaReceipt === quotaId) entry = peer
      else if (peer && peer.cacheWriter !== draft.cacheWriter && !jsonEqual(peer.workspace, inherited)) {
        entry = peer.dirty ? combineDrafts(draft, peer, observedMain) : combineDrafts(peer, draft, observedMain)
      }
      this.quotaRecovery = { key, source: found.value, localView: entry.workspace, observedMain: peer?.workspace }
      return { ...entry, quotaReceipt: quotaId }
    }, defer)
  }

  private async writeQuotaRecovery(recovery: QuotaRecovery, entry: CacheEntry, parkedReceipt?: string): Promise<boolean> {
    const previous = recovery.source
    if (entry.dirty) {
      let saved: QuotaDraft | undefined
      const stored = await idbUpdate<QuotaDraft>(recovery.key, (current) => {
        const changed = current && current.quotaId !== previous.quotaId && current.cacheWriter !== this.writerId
        // A restricted view never received wider additions that arrived after open. Keep them
        // across its later saves until open() has durably parked that exact receipt.
        const wider = current && this.mustParkForRole(current) && current.quotaId !== parkedReceipt
        const draft = changed || wider ? combineDrafts(current, entry, recovery.localView) : entry
        saved = { ...draft, quotaId: newId('quota'), observedMain: recovery.observedMain }
        return saved
      })
      if (stored && saved) {
        recovery.source = saved
        recovery.localView = entry.workspace
        if (this.sessionActive && !this.mustParkForRole(saved) && !jsonEqual(saved.workspace, entry.workspace)) {
          const workspace = this.entry.workspace === entry.workspace ? saved.workspace
            : this.merge(entry.workspace, this.entry.workspace, saved.workspace)
          this.saveSeq++
          this.entry = { ...this.entry, dirty: true, workspace }
          recovery.localView = saved.workspace
          this.handToView(workspace, this.entry.baseRev)
          this.setStatus('pending')
          this.armDebounce()
        }
      }
      return stored
    }
    // An acknowledgement or durable role/refusal park has settled this editor's work.
    // Fold in concurrent changes to the SAME owner's cache against what the view saw.
    // A different owner keeps the shared slot, including if ownership changes inside IDB.
    const seq = this.saveSeq
    const currentAck = () => this.sessionActive && this.saveSeq === seq && !this.entry.dirty
    if (!currentAck()) return false
    const reconcile = (latest: CacheEntry | null): CacheEntry => {
      if (latest && latest.baseRev > entry.baseRev) return latest // a newer server acknowledgement too
      if (!latest?.dirty || jsonEqual(latest.workspace, recovery.observedMain)) return entry
      const merged = combineDrafts(entry, latest, recovery.observedMain)
      return { ...merged, base: entry.base, baseRev: entry.baseRev, dirty: !jsonEqual(merged.workspace, entry.workspace) }
    }
    let foreign = false
    const published = await idbUpdate<CacheEntry>(cacheKey(this.incidentId), (latest) => {
      if (!currentAck()) return undefined
      foreign = !!latest && latest.owner !== entry.owner
      return foreign ? undefined : reconcile(latest)
    })
    if (!published || !currentAck()) return false
    if (foreign && entry.owner) {
      // The peer may have parked our observed copy while the PUT was in flight. Retire the
      // acknowledged part there too, so an old parked save cannot replay over the server.
      const settled = await idbUpdate<CacheEntry>(ownerCacheKey(this.incidentId, entry.owner), (parked) => {
        if (!currentAck() || !parked || parked.owner !== entry.owner) return undefined
        const remaining = reconcile(parked)
        return remaining.dirty ? remaining : null
      })
      if (!settled || !currentAck()) return false
    }
    return idbUpdate<QuotaDraft>(recovery.key, (current) =>
      currentAck() && current && !this.mustParkForRole(current) &&
      current.quotaId === previous.quotaId ? null : undefined)
  }

  /** What this session pushes: the whole document, or its slice. */
  private get shape(): 'all' | Slice {
    return this.opts.slice ?? 'all'
  }

  /** Is `entry` unsynced work this session's push cannot carry whole? Only a slice session can
   *  lack something, and only a stamped entry says what made it (an unstamped one is older than
   *  the stamp: unknown, so never parked — a false «nicht übernommen» is a wolf cried). */
  private mustParkForRole(entry: CacheEntry): boolean {
    return !!this.opts.slice && !!entry.shape && entry.shape !== this.opts.slice
  }

  /** Copy `entry` into its owner's role slot (roleCacheKey). Resolves whether the copy is
   *  durable; an unreadable slot is never written over (the idb rule — a failed read is not a miss). */
  private async parkForRole(entry: CacheEntry): Promise<boolean> {
    const key = roleCacheKey(this.incidentId, entry.owner ?? '')
    const read = await idbRead<RefusedWorkspace[]>(key)
    if (!read.ok || !this.sessionActive) return false
    const item: RefusedWorkspace = { workspace: entry.workspace, base: entry.base, baseRev: entry.baseRev, refusedAt: Date.now(), owner: entry.owner }
    const next = [...(Array.isArray(read.value) ? read.value : []), item]
    if (!(await idbSet(key, next)) || !this.sessionActive) return false
    if ((entry.owner ?? '') === (cacheOwner ?? '')) {
      this.roleParked = next
      this.emitRoleParked()
    }
    return true
  }

  /** Preserve unattributable pre-ownership unsynced work before its slot is reused. First writer
   *  wins: an orphan already parked is the real pre-upgrade copy, so it is never overwritten by a
   *  later (necessarily post-upgrade, hence owner-stamped) main-slot state — and, being already
   *  parked, it is itself a durable copy. Returns whether a durable copy now exists at the orphan
   *  key (an existing one, or a freshly written one), so the caller can honour durable-or-abort. */
  private async parkOrphan(stored: CacheEntry): Promise<boolean> {
    const existing = await idbRead<CacheEntry>(orphanCacheKey(this.incidentId))
    // an unreadable orphan slot may hold the real pre-upgrade copy: not durable, never overwrite
    if (!existing.ok || !this.sessionActive) return false
    if (existing.value) return true
    return idbSet(orphanCacheKey(this.incidentId), stored)
  }

  /** The server answered, but the main slot holds another session's unsynced dirty work that could
   *  not be parked durably (a full store). Overwriting it would destroy the only copy, so serve the
   *  fetched workspace from MEMORY and leave the cache untouched: this session runs without a
   *  durable cache for this incident (mainSlotBlocked) until a reload re-attempts the park after the
   *  storage pressure clears. The degraded durability surfaces via cacheDurable — the honest place
   *  for it is the Offline-Bereitschaft sheet (device readiness), since the server has our latest. */
  private serveServerWithoutCaching(ws: Workspace, rev: number): { workspace: Workspace; rev: number; fromCache: false } {
    this.mainSlotBlocked = true
    this.entry = { workspace: ws, base: ws, baseRev: rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? undefined }
    this.cacheDurable = false
    this.opts.onRev?.(rev)
    this.setStatus('synced')
    this.scheduleProbe()
    return { workspace: ws, rev, fromCache: false }
  }

  /** Load initial state: prefer server; fall back to offline cache when the server could not be
   *  ASKED. A server that answered «no» gets no fallback — see mayRead / isDenial. */
  async init(): Promise<{ workspace: Workspace | null; rev: number; fromCache: boolean }> {
    const opened = await this.open()
    this.requireOpeningOwner()
    // what the caller hydrates the view from — every renumbering is said against it from now on
    this.viewState = opened.workspace ?? {}
    return opened
  }

  private async open(): Promise<{ workspace: Workspace | null; rev: number; fromCache: boolean }> {
    // Read the offline cache once up front and seed entry/status from it, so the sync badge is
    // correct even while the server fetch is in flight (and so a cold offline reopen restores
    // unsynced edits immediately). The server fetch below refines this.
    const read = await readCache(this.incidentId)
    this.requireOpeningOwner()
    // ⚠️ A slot that could not be READ is not an empty one. Treated as «no cache», the server copy
    // below was adopted and written over whatever the slot held — on a device that had been
    // offline, the only copy of its unsynced edits (23.09.2026). Block the slot instead: the
    // session runs from the server copy in memory, reports the cache as not durable, and
    // re-probes the slot on its next write (slotUnread). Nothing here may write the main slot,
    // which is why loadReadableEntry (its adopt and re-home both do) is skipped too.
    if (!read.ok) this.slotUnread = true
    // Decide what THIS session may load — and protect what it may not (see loadReadableEntry:
    // another user's unsynced work is parked, never destroyed or served to a different account).
    const recovery = read.ok ? await this.restoreQuotaDraft(read.value) : null
    this.requireOpeningOwner()
    let { entry: cached, parkBlocked } = recovery
      ? { entry: recovery, parkBlocked: false }
      : read.ok ? await this.loadReadableEntry(read.value) : { entry: null, parkBlocked: true }
    this.requireOpeningOwner()
    // Unsynced work of a WIDER shape than this session can push (RBAC audit S4): park a copy before
    // anything below reuses the slot — durable-or-abort, like a foreign owner's work. The record
    // part still merges and goes up as before; the copy keeps the rest for «Einträge sichern».
    if (cached?.dirty && this.mustParkForRole(cached)) {
      const parked = await this.parkForRole(cached)
      this.requireOpeningOwner()
      if (parked) {
        cached = { ...cached, shape: this.shape }
        if (this.quotaRecovery) await this.writeQuotaRecovery(this.quotaRecovery, cached, cached.quotaReceipt)
        else await idbSet(cacheKey(this.incidentId), cached) // parked once: a reload must not park it again
        this.requireOpeningOwner()
      } else {
        parkBlocked = true
      }
    }
    if (cached) {
      this.inheritedDirty = cached.dirty ? cached.workspace : undefined
      this.entry = cached
      this.setStatus(cached.dirty ? 'pending' : 'synced')
    }
    try {
      const { workspace, workspace_rev } = await getWorkspace(this.incidentId)
      this.requireOpeningOwner()
      const ws = workspace ?? {}
      // The main slot holds an unserved dirty entry loadReadableEntry could NOT park durably. It is
      // the only copy of that work, so we must not reuse the slot: serve the server snapshot from
      // memory and leave the cache untouched (durable-or-abort — see serveServerWithoutCaching).
      if (parkBlocked) return this.serveServerWithoutCaching(ws, workspace_rev)
      if (cached?.dirty) {
        // Unsynced local edits sit in the offline cache. If they're at the same base the server
        // is at, keep them verbatim. If the server advanced while we were offline (a cold reopen
        // after another device pushed), three-way merge our edits against it using the cached
        // ancestor — the reopen analogue of the live 409 path — so independent edits both survive
        // instead of the local ones being silently dropped. The merge result stays dirty and a
        // later flush pushes it at the new rev.
        if (cached.baseRev === workspace_rev) {
          this.entry = cached
          this.setStatus('pending')
          return { workspace: cached.workspace, rev: workspace_rev, fromCache: true }
        }
        const server = workspace ?? {}
        const merged = this.mergeReporting(cached.base ?? {}, cached.workspace, server)
        // the offline work was written (and its Verlauf rows with it) under the cached numbers
        this.reportRenumbered(cached.workspace, merged)
        this.entry = { workspace: merged, base: server, baseRev: workspace_rev, dirty: true, lastSyncedAt: cached.lastSyncedAt, owner: this.sessionOwner ?? cached.owner, requeuedRefused: cached.requeuedRefused, quotaReceipt: cached.quotaReceipt, shape: this.shape }
        this.writeCache()
        this.opts.onRev?.(workspace_rev)
        this.setStatus('pending')
        return { workspace: merged, rev: workspace_rev, fromCache: true }
      }
      this.entry = { workspace: ws, base: ws, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? undefined, requeuedRefused: cached?.requeuedRefused, quotaReceipt: cached?.quotaReceipt }
      this.writeCache()
      this.opts.onRev?.(workspace_rev)
      this.setStatus('synced')
      return { workspace, rev: workspace_rev, fromCache: false }
    } catch (e) {
      this.requireOpeningOwner()
      // ⚠️ The offline fallback answers SILENCE, never a refusal (SEC-10). A 401 says this
      // browser has no session left, so the device may not answer from its own copy either —
      // and a 401 is device-wide, so every other open incident is locked with it. A 403 is
      // narrower (this session, this incident: an Einsatz-Link outside its Einsatz), so it
      // closes this read alone. Everything else — 5xx, a 404, a merge that threw — keeps the
      // old fallback: nothing about it says the operator lost their right to their own work.
      if (isDenial(e)) {
        if (e instanceof ApiError && e.status === 401) denyWorkspaceCache()
        throw e
      }
      if (cached && mayRead(cached)) {
        this.entry = cached
        this.setStatus(cached.dirty ? 'pending' : 'synced')
        return { workspace: cached.workspace, rev: cached.baseRev, fromCache: true }
      }
      throw e
    }
  }

  /** Queue a save. Writes the offline cache immediately; flushes to server debounced.
   *
   *  `keepTimer`: a push already armed stays at its time instead of restarting the debounce. For
   *  a save the caller made without comparing (useIncidentSync's mid-gesture skip): those can
   *  arrive faster than the debounce indefinitely — a caret left in a field while other state
   *  churns — and restarting it on each held the push back for as long as the churn lasted. */
  save(workspace: Workspace, { keepTimer = false }: { keepTimer?: boolean } = {}) {
    // A denial still permits local edits until the session changes. A late render of the
    // previous session must never enqueue a new edit (including after a logout and re-login).
    if (!this.ownsCache) return
    this.saveSeq++
    // Stamp the editing session NOW (the enqueue moment), so the debounced write can't be
    // relabelled if the identity changes before it lands (SEC-10 owner races). An entry that
    // already knows its owner keeps it — recovered/parked work stays its author's.
    const pending = this.pendingViewMerge
    const draft = pending ? this.merge(pending.view, workspace, pending.merged) : workspace
    this.entry = { ...this.entry, workspace: draft, dirty: true, owner: this.entry.owner ?? cacheOwner ?? undefined, editedAt: serverNow(), shape: this.shape }
    this.viewState = workspace
    this.writeCache()
    this.setStatus('pending')
    this.armDebounce(keepTimer)
  }

  private armDebounce(keepTimer = false) {
    if (this.timer) {
      if (keepTimer) return
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => { this.timer = null; void this.run() }, this.debounceMs)
  }

  /** Await the shared attempt and any newer edit rebased onto its successful response.
   *
   *  ⚠️ A flush asked for WHILE an attempt is in flight is owed its own attempt if that one
   *  fails (the journal's rule, #209): the `online` handler, the reach signal
   *  (lib/connectivity) and «Jetzt synchronisieren» arrive exactly when an attempt sent under
   *  the old conditions may still be settling — merely joining it left the edits for the
   *  backoff, up to 60 s later. Only a failure to REACH the server is re-run (a
   *  401, a refused slice or an exhausted merge is an answer, and asking again changes nothing),
   *  once per request, so an offline device does not spin. The engine's own timers (debounce,
   *  backoff) go through `run` and ask for nothing: they carry no news about the link. */
  flush(): Promise<void> {
    if (this.flushing) this.flushRequested = true
    return this.run()
  }

  private run(): Promise<void> {
    if (this.flushing) return this.flushing
    if (!this.entry.dirty || !this.sessionActive) return Promise.resolve()
    this.flushing = (async () => {
      do {
        this.flushRequested = false
        this.unreached = false
        await this.drain()
      } while (this.flushRequested && this.unreached && this.entry.dirty && this.sessionActive)
    })().finally(() => {
      this.flushing = null
      // A failed attempt keeps the existing automatic backoff; joining callers never spin.
      if (this.entry.dirty && !this.timer && this.sessionActive) this.scheduleRetry()
    })
    return this.flushing
  }

  /** Push what this engine holds unsynced, after the usual debounce — for an editor that opened
   *  with a restored dirty entry and edits nothing (useIncidentSync). Nothing armed that push
   *  before (hunt 24.11.2026, offline-sync F4): on a healthy link the badge said «wird
   *  gespeichert» until the next edit, and the edit stayed on this device. */
  pushOwed(): void {
    if (this.entry.dirty && this.sessionActive && !this.timer && !this.flushing) this.armDebounce()
  }

  private async drain(): Promise<void> {
    while (this.entry.dirty && this.sessionActive) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      try {
        if (this.quotaRecovery) {
          // Another recovery view can have added edits under this author. Admit and reconcile
          // the draft before selecting the payload; an acknowledgement covers only what was sent.
          await this.cacheWrite
          if (!this.sessionActive) return
          this.writeCache()
          await this.flushCache()
          if (!this.sessionActive) return
        } else {
          this.flushCache() // the cache must carry what is about to become the ancestor
        }
        await this.pushCurrent()
      } catch (e) {
        if (!this.sessionActive) return
        // ⚠️ BEFORE the 409 branch: this 409 is not a revision conflict — merging and retrying
        // would only collect it again (N3). The save is parked and the view goes back to the record.
        if (isIncidentClosedRefusal(e)) {
          if (!(await this.parkRefused(e))) return
        } else if (isOlderBuildRefusal(e)) {
          // nor is this one: a newer build wrote the blob — never merged, never re-sent
          if (!(await this.parkOlderBuild())) return
        } else if (e instanceof ApiError && e.status === 409) {
          if (!(await this.resolveConflict())) return
        } else {
          // A revoked session closes cached reads device-wide while preserving dirty work.
          // A 403 can be a legitimately refused link slice and must not revoke the device.
          if (e instanceof ApiError && e.status === 401) denyWorkspaceCache()
          this.setStatus(e instanceof ApiError && e.status === 0 ? 'offline' : 'error')
          this.unreached = isUnverifiable(e)
          return
        }
      }
      // Only successful acknowledgements reach the next iteration. A save made during
      // the PUT stays dirty and is sent now, so an explicit sync cannot finish ahead of it.
    }
  }

  /** Exponential-backoff re-flush: 5s · 10s · 20s · 40s · then every 60s while dirty. */
  private scheduleRetry() {
    if (this.disposed) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = Math.min(60_000, 5_000 * 2 ** this.retryCount)
    this.retryCount++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.run()
    }, delay)
  }

  /**
   * Last-ditch flush for page teardown (tab hidden / pagehide). The async flush() above
   * issues a normal fetch that the browser aborts the instant the document unloads — on iOS
   * PWAs (backgrounded / locked / swiped away) that's the usual path, so edits made inside
   * the debounce window reach only this device's cache and are lost on any other device.
   * This fires a `keepalive` PUT the browser completes after teardown. Fire-and-forget: we
   * can't await or merge the response while the page is dying, so dirty/baseRev stay as-is —
   * a same-device reopen still reconciles from the cache, and once the server accepts this
   * push every device's next load (or live-poll) pulls the up-to-date revision. If the push
   * raced a concurrent server edit (409) it's simply dropped server-side; the next real
   * flush() resolves it via the normal three-way merge. No-op when clean.
   * ⚠️ Only the SMALL saves go (the Trupp slice, the record slice). The browser caps every
   * in-flight keepalive body together at ~64 KB and a real 5 h Einsatz is ~97 KB
   * (docs/testing/fat-incident.md): the whole document was refused, and one just under the cap
   * starved the Trupp and Verlauf beacons beside it. A whole-document edit waits in the cache
   * for the next open (15.11.2026). */
  flushKeepalive(): void {
    this.flushCache() // the page is dying — the debounce would never fire
    if (!this.entry.dirty || !this.sessionActive) return
    const v = versionOf(this.entry.workspace)
    if (this.opts.slice === 'record') putWorkspaceRecordBeacon(this.incidentId, recordSlice(this.entry.workspace), this.entry.baseRev, v)
    else if (this.opts.slice === 'trupps' || onlyTruppsChanged(this.entry.base, this.entry.workspace)) putWorkspaceTruppsBeacon(this.incidentId, truppSlice(this.entry.workspace), this.entry.baseRev, this.editedAtIso(), v)
  }

  /** The ONE write. A `slice` sends its subset on its own route; everything else about a
   *  push — when, at which base_rev, and what a 409 means — is identical, which is why the
   *  merge/retry machinery below never has to know which session it is running in.
   *  Both callers set `entry.base` to the server's copy at `baseRev` before they push, so an
   *  editor's save that changed only Trupps goes the slice route as well (onlyTruppsChanged). */
  private async push(workspace: Workspace, baseRev: number) {
    const v = versionOf(workspace)
    if (this.opts.slice === 'trupps') return putWorkspaceTrupps(this.incidentId, truppSlice(workspace), baseRev, this.editedAtIso(), this.writerId, v)
    if (this.opts.slice === 'record') return putWorkspaceRecord(this.incidentId, recordSlice(workspace), baseRev, this.writerId, v)
    if (onlyTruppsChanged(this.entry.base, workspace)) {
      try {
        return await putWorkspaceTrupps(this.incidentId, truppSlice(workspace), baseRev, this.editedAtIso(), this.writerId, v)
      } catch (e) {
        // ⚠️ The slice validates EVERY Trupp it is sent; the full save keeps an unchanged legacy
        // row it would refuse (backend alarm_validation · retained rows). A 422 here may be one
        // of those, so the whole document goes as it always did — and answers for itself.
        if (!this.sessionActive || !(e instanceof ApiError && e.status === 422)) throw e
      }
    }
    return putWorkspace(this.incidentId, workspace, baseRev, this.editedAtIso(), this.writerId)
  }

  /** `edited_at` for a push — when the newest edit in it was made (CacheEntry.editedAt) */
  private editedAtIso(): string | undefined {
    return this.entry.editedAt != null ? new Date(this.entry.editedAt).toISOString() : undefined
  }

  // Push the current workspace at the current baseRev. On success, advance baseRev and
  // clear dirty — UNLESS a newer save() landed during the in-flight PUT (detected via
  // saveSeq), in which case the newest content stays dirty and we re-arm a flush so it
  // isn't silently marked synced-but-never-sent. Throws on 409/other for the caller.
  private async pushCurrent(): Promise<void> {
    const seqAtStart = this.saveSeq
    const pushed = this.entry.workspace
    const serverHad = this.entry.base ?? {}
    const { workspace_rev } = await this.push(pushed, this.entry.baseRev)
    if (!this.sessionActive) return
    this.retryCount = 0 // server accepted a push → backoff starts over on the next failure
    // a merge this device made earlier (a cold reopen, a found slot) may have renumbered what the
    // server held; now that it is ON the server, this device says so — see resolveConflict
    this.reportRenumbered(serverHad, pushed)
    // the server now holds what we pushed — all of it, or (a slice session) its copy with our
    // slice in it (landedSlice). That becomes the new merge ancestor.
    const landed = this.opts.slice ? landedSlice(serverHad, pushed, this.opts.slice) : pushed
    if (this.saveSeq === seqAtStart) {
      this.entry = { ...this.entry, base: landed, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
      this.setStatus('synced')
    } else {
      // a newer edit arrived mid-flush — keep it dirty (rebased) and schedule another flush.
      // The ancestor is still what we just pushed (the part the server has).
      this.entry = { ...this.entry, base: landed, baseRev: workspace_rev, lastSyncedAt: Date.now() }
      this.setStatus('pending')
      this.armDebounce()
    }
    this.writeCache()
    this.opts.onRev?.(workspace_rev)
  }

  // The server moved ahead of us (409). Instead of one whole snapshot winning, three-way
  // merge our edits and the server's against their common ancestor (entry.base) and push the
  // union: independent edits both survive, same-object edits are last-writer-wins, deletes
  // beat concurrent edits. We're inside an in-flight flush(), so push DIRECTLY (calling
  // flush() would join the very promise we are resolving). Retry a fresh 409 by re-merging.
  //
  // The fetch and the merge sit INSIDE the try on purpose: a GET that dies offline mid-merge,
  // or a merge that throws on a server blob this app did not write, used to escape flush()'s
  // own catch as an unhandled rejection — no status, no toast, and the backoff re-threw it every
  // 5–60 s. Now either lands in 'offline' / 'error' like a failed push, so the sync toast and
  // «Jetzt synchronisieren» appear and the edits stay dirty in the cache.
  private async resolveConflict(): Promise<boolean> {
    const mine0 = this.entry.workspace
    const showPendingMerge = () => {
      if (!this.pendingViewMerge || !this.sessionActive) return
      this.reportRenumbered(this.viewState, this.entry.workspace)
      this.handToView(this.entry.workspace, this.entry.baseRev)
    }
    for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt++) {
      // a RE-merge (another device landed during ours) waits a jittered moment first — see
      // conflictBackoffMs. The first merge after the original 409 goes at once.
      const wait = conflictBackoffMs(attempt)
      if (wait) {
        await new Promise((resolve) => setTimeout(resolve, wait))
        if (!this.sessionActive) return false
      }
      try {
        const server = await getWorkspace(this.incidentId)
        if (!this.sessionActive) return false
        const merged = this.mergeReporting(this.entry.base ?? {}, this.entry.workspace, server.workspace ?? {})
        this.pendingViewMerge = { view: this.viewState, merged }
        this.entry = { ...this.entry, workspace: merged, base: server.workspace ?? {}, baseRev: server.workspace_rev, dirty: true }
        this.writeCache()
        this.flushCache() // persist this dirty ancestor before the PUT, as drain() does on the first attempt
        const seqAtStart = this.saveSeq
        const { workspace_rev } = await this.push(merged, server.workspace_rev)
        if (!this.sessionActive) return false
        this.opts.onRev?.(workspace_rev)
        this.retryCount = 0 // merge landed → backoff starts over on the next failure
        // ⚠️ The RESOLVING device says what its merge renumbered of the server's copy, once that
        // is on the server. The devices that minted those numbers would say it too when their
        // view is handed the change — but one of them may be an Atemschutz-Link, or reopen later
        // from a clean cache and simply adopt the server copy with nothing to compare. The row
        // id is derived from the change (truppNumbers · renumberRow), so saying it twice is once.
        this.reportRenumbered(server.workspace ?? {}, merged)
        const landed = this.opts.slice ? landedSlice(server.workspace ?? {}, merged, this.opts.slice) : merged
        if (this.saveSeq === seqAtStart) {
          this.entry = { ...this.entry, base: landed, baseRev: workspace_rev, dirty: false, lastSyncedAt: Date.now() }
          this.writeCache()
          this.setStatus('synced')
        } else {
          // save() already rebased the newer draft onto this merge. Only its ancestor advances.
          this.entry = { ...this.entry, base: landed, baseRev: workspace_rev, dirty: true, lastSyncedAt: Date.now() }
          this.writeCache()
          this.setStatus('pending')
          this.armDebounce()
        }
        // Apply BOTH branches to the live view. Its next edit is built from this state;
        // leaving the remerged union only in the cache would delete remote additions on
        // that next save, now at a current revision where no 409 can rescue them.
        // What the view showed is said against what it is handed: `mine0` (the content that 409'd)
        // AND the view's latest state — a Trupp registered while this merge was in flight is in
        // that one only, and the re-base above may have renumbered it (review of #228).
        this.reportRenumbered(mine0, this.entry.workspace)
        this.reportRenumbered(this.viewState, this.entry.workspace)
        this.handToView(this.entry.workspace, workspace_rev)
        this.opts.onMerged?.()
        return true
      } catch (e) {
        if (!this.sessionActive) return false
        // the merge landed on a closed Einsatz — the same answer as a plain push gets (see drain)
        if (isIncidentClosedRefusal(e) || isOlderBuildRefusal(e)) {
          const parked = isIncidentClosedRefusal(e) ? await this.parkRefused(e) : await this.parkOlderBuild()
          showPendingMerge() // a failed park or a newer edit can still leave the merged draft owed
          return parked
        }
        if (e instanceof ApiError && e.status === 409) continue // someone else landed too — re-merge
        showPendingMerge()
        if (e instanceof ApiError && e.status === 401) denyWorkspaceCache() // revoked mid-merge — deny device-wide, like flush()
        this.setStatus(e instanceof ApiError && e.status === 0 ? 'offline' : 'error')
        this.unreached = isUnverifiable(e)
        return false // offline/other: stay dirty + merged; a later flush retries
      }
    }
    // retries exhausted — leave it dirty for a later flush to pick up
    showPendingMerge()
    this.setStatus('error')
    return false
  }

  /**
   * The server refused the save because the Einsatz is CLOSED and the save's newest edit was made
   * after the close (lib/incidentClosed, N3). In this order:
   *  1. PARK the blob in the refused slot — durably, or not at all: a failed IndexedDB write must
   *     never claim local durability, so on failure the entry simply stays dirty in the main slot
   *     (still this device's copy) and the status says so.
   *  2. Save what the closed Einsatz still TAKES (review of #235): the record part — a Rapport
   *     correction typed on the same save as a Tafel tap — goes up again on its own through the
   *     record route (`putWorkspaceRecord`), which a closed Einsatz accepts. It used to go down
   *     with the refused rest and resurface only in the export.
   *  3. Put the RECORD back on screen at once, from what is known without asking: the ancestor the
   *     refused save was built on IS the server's current blob (the revision check passed before
   *     the refusal), plus the record part if it just landed. Only without an ancestor (an old
   *     cache) is the server asked — and if that fails, the view is flagged and re-fetched on a
   *     backoff, the status saying `error` meanwhile, so a refused state never stands as «synced».
   * Resolves true once parked, false when the park itself failed.
   */
  private async parkRefused(e: unknown): Promise<boolean> {
    const pushed = this.entry.workspace
    const base = this.entry.base
    const baseRev = this.entry.baseRev
    const id = newId('refusal')
    const item: RefusedWorkspace = { id, shape: this.shape, workspace: pushed, base, baseRev, refusedAt: Date.now(), owner: this.entry.owner }
    const seqAtPark = this.saveSeq
    // An immutable slot per refusal: a late write from a previous account cannot replace
    // another writer's drafts. Older aggregate and timestamp slots are still read below.
    const prefix = refusedCacheKey(this.incidentId)
    const key = item.owner ? `${refusedOwnerPrefix(prefix, item.owner)}${id}` : `${prefix}:unattributed:${id}`
    const durable = await idbSet(key, [item])
    if (!this.sessionActive) return false
    reportIncidentClosed({ incidentId: this.incidentId, closedAt: refusalClosedAt(e), source: 'refusal' })
    if (!durable) {
      this.cacheDurable = false
      this.setStatus('error')
      return false
    }
    this.refusedKeys.add(key)
    if (!this.refused.some((r) => r.id === id)) this.refused.push(item)
    this.emitRefused()
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.retryCount = 0
    // a save made while the park was in flight is not in the parked blob: it stays owed
    if (this.saveSeq !== seqAtPark) { this.setStatus('pending'); this.armDebounce(); return true }

    // (2) the record part, on its own route — only the full-document engine can have one to save
    let landed: { workspace: Workspace; rev: number } | null = null
    if (this.sessionActive && !this.opts.slice && base) {
      const record = recordSlice(pushed)
      const changed = RECORD_SLICE_KEYS.some((k) => !jsonEqual(record[k], base[k]))
      if (changed) {
        try {
          const { workspace_rev } = await putWorkspaceRecord(this.incidentId, record, baseRev, this.writerId, versionOf(pushed))
          landed = { workspace: { ...base, ...record }, rev: workspace_rev }
        } catch { /* parked whole — the export and a reopen still carry it */ }
        if (!this.sessionActive) return false
        if (this.saveSeq !== seqAtPark) { this.setStatus('pending'); this.armDebounce(); return true }
      }
    }
    // (3) the record back on screen
    const shown = landed ?? (base ? { workspace: base, rev: baseRev } : null)
    if (shown) {
      this.entry = { ...this.entry, workspace: shown.workspace, base: shown.workspace, baseRev: shown.rev, dirty: false, lastSyncedAt: Date.now() }
      this.writeCache()
      if (landed) this.opts.onRev?.(landed.rev)
      this.setStatus('synced')
      this.handToView(shown.workspace, shown.rev)
      return true
    }
    this.entry = { ...this.entry, dirty: false }
    this.writeCache()
    await this.refetchRecord()
    return true
  }

  /**
   * The server refused the save because a NEWER build wrote its blob (409 `workspace_older_build`,
   * backend workspace_kinds · refuse_older_build; sweep 30.10.2026 #19). What was pushed lacks
   * whatever its build could not read — this build's, or a leftover cache entry an older build
   * stamped — so it is never merged and never sent again:
   *  1. a copy goes to the role slot (parkForRole): exported by «Einträge sichern», never re-sent —
   *     durably, or the entry stays dirty and the status says `error`;
   *  2. the server's blob is adopted. The refused save sat on it (the server checks the revision
   *     first), so the ancestor IS it; without one it is fetched. Handed to the view, whose load
   *     gate turns an older build read-only and reloads it into the newer one
   *     (useWorkspaceBlob · olderBuild); a current build simply goes on from the server's blob.
   * Resolves true once handled.
   */
  private async parkOlderBuild(): Promise<boolean> {
    const parked = await this.parkForRole(this.entry)
    if (!this.sessionActive) return false
    if (!parked) {
      this.cacheDurable = false
      this.setStatus('error')
      return false
    }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.retryCount = 0
    let server = this.entry.base ? { workspace: this.entry.base, rev: this.entry.baseRev } : null
    if (!server) {
      try {
        const r = await getWorkspace(this.incidentId)
        server = { workspace: r.workspace ?? {}, rev: r.workspace_rev }
      } catch {
        if (!this.sessionActive) return false
        // parked already: not owed again — the view keeps what it shows until the next change
        this.entry = { ...this.entry, dirty: false }
        this.writeCache()
        this.setStatus('error')
        return true
      }
      if (!this.sessionActive) return false
    }
    this.entry = { ...this.entry, workspace: server.workspace, base: server.workspace, baseRev: server.rev, dirty: false, lastSyncedAt: Date.now() }
    this.writeCache()
    this.opts.onRev?.(server.rev)
    this.setStatus('synced')
    this.handToView(server.workspace, server.rev)
    return true
  }

  /** The view still shows a refused state and there was no ancestor to put back: fetch the
   *  record, and until that works say `error` and try again on the retry backoff. */
  private refetchOwed = false
  private refetchTimer: ReturnType<typeof setTimeout> | null = null
  private refetchCount = 0
  private async refetchRecord(): Promise<void> {
    try {
      const server = await getWorkspace(this.incidentId)
      if (!this.sessionActive) return
      this.refetchOwed = false
      this.refetchCount = 0
      if (this.entry.dirty) return // a new edit merges against the server on its own push
      const ws = server.workspace ?? {}
      this.adoptServer(ws, server.workspace_rev)
      this.handToView(ws, server.workspace_rev)
    } catch {
      if (!this.sessionActive) return
      this.refetchOwed = true
      this.setStatus('error')
      const delay = Math.min(60_000, 5_000 * 2 ** this.refetchCount++)
      if (this.refetchTimer) clearTimeout(this.refetchTimer)
      this.refetchTimer = setTimeout(() => { this.refetchTimer = null; if (this.refetchOwed) void this.refetchRecord() }, delay)
    }
  }

  /** The refused count, as it changes — what the UI says «nicht übernommen» with. Subscribing reads
   *  the slot (so a reload still counts and exports what an earlier session parked). Returns the
   *  unsubscribe. */
  subscribeRefused(listener: (count: number) => void): () => void {
    this.refusedListeners.add(listener)
    void this.loadRefused()
    return () => { this.refusedListeners.delete(listener) }
  }

  private emitRefused() {
    if (this.disposed) return
    for (const l of [...this.refusedListeners]) l(this.refusedCount)
    this.emitRoleParked()
  }

  /** Load the legacy aggregate, timestamp fallback slots and current per-refusal slots,
   *  merging with anything parked in this session meanwhile.
   *  Resolves true once every slot was read (a miss included), false when any read failed —
   *  then nothing is cached, so the next call reads again. */
  private refusedLoad: Promise<boolean> | null = null
  loadRefused(): Promise<boolean> {
    if (!this.refusedLoad) {
      const key = refusedCacheKey(this.incidentId)
      const gen = ++this.refusedGen
      this.refusedLoad = (async () => {
        const read = await idbRead<RefusedWorkspace[]>(key)
        const found: RefusedWorkspace[] = read.ok && Array.isArray(read.value) ? [...read.value] : []
        const extra = await idbKeys(`${key}:`)
        const ownPrefix = this.sessionOwner && refusedOwnerPrefix(key, this.sessionOwner)
        const fallbackKeys = (extra.ok ? extra.value ?? [] : []).filter((k) =>
          /^\d+$/.test(k.slice(key.length + 1)) || (ownPrefix && k.startsWith(ownPrefix)))
        let complete = read.ok && extra.ok
        for (const k of fallbackKeys) {
          const r = await idbRead<RefusedWorkspace[]>(k)
          if (!r.ok) complete = false
          else if (Array.isArray(r.value)) found.push(...r.value)
        }
        for (const k of [key, ...fallbackKeys]) this.refusedKeys.add(k)
        if (found.length) {
          for (const item of found) {
            if (!this.refused.some((r) => (r.id ?? r.refusedAt) === (item.id ?? item.refusedAt) && r.owner === item.owner)) this.refused.push(item)
          }
          this.refused.sort((a, b) => a.refusedAt - b.refusedAt)
          this.emitRefused()
        }
        if (!complete && this.refusedGen === gen) this.refusedLoad = null
        return complete
      })()
    }
    return this.refusedLoad
  }
  private refusedKeys = new Set<string>()
  private refusedGen = 0

  /**
   * The Einsatz runs again («Wieder öffnen», review of #235): send what was parked. Each parked
   * blob is merged three-way onto the current state against the ancestor it was built on, the
   * result saved like any edit (a debounce, the 409 merge, a fresh refusal parks it again), and
   * the slots are emptied. Everything after the reopen prints as a Nachtrag.
   */
  private requeueFlight: Promise<void> | null = null
  requeueRefused(): Promise<void> {
    return this.requeueFlight ??= this.transferRefused().finally(() => { this.requeueFlight = null })
  }

  private async transferRefused(): Promise<void> {
    // ⚠️ Only once every slot was actually read: emptying a slot that could not be read would
    // destroy what an earlier session parked there. Unread ⇒ nothing is re-sent now; the next
    // attempt (the next render that sees the Einsatz running) reads again.
    if (!(await this.loadRefused())) return
    const parked = this.ownRefused()
    if (!parked.length) return
    const transferred = new Set(this.entry.requeuedRefused)
    let ws = this.entry.workspace
    for (const p of parked) {
      const marker = p.id ?? p.refusedAt
      if (!transferred.has(marker)) ws = this.merge(p.base ?? {}, p.workspace, ws)
      transferred.add(marker)
    }
    this.entry = { ...this.entry, requeuedRefused: [...transferred] }
    this.pendingViewMerge = null // recovery already merged onto the durable draft and hands it to the view
    this.save(ws)
    this.handToView(ws, this.entry.baseRev)
    // Commit the replacement FIRST. Even a quota failure or a reload in this await leaves
    // one durable copy. The marker above makes retry after a failed clear idempotent.
    if (!(await this.flushCache()) || !this.sessionActive) return
    const markers = new Set(parked.map((p) => p.id ?? p.refusedAt))
    const main = refusedCacheKey(this.incidentId)
    for (const key of this.refusedKeys) {
      const read = await idbRead<RefusedWorkspace[]>(key)
      if (!read.ok || !this.sessionActive) return
      if (!read.value) continue
      const keep = read.value.filter((p) => p.owner !== this.sessionOwner || !markers.has(p.id ?? p.refusedAt))
      if (keep.length === read.value.length) continue
      // A plain delete acknowledges no durability. First persist the filtered contents so
      // even a failed cleanup cannot replay this copy over a later edit on the next launch.
      if (!(await idbSet(key, keep)) || !this.sessionActive) return
      if (!keep.length && key !== main) {
        await idbDel(key)
        if (!this.sessionActive) return
        this.refusedKeys.delete(key)
      }
    }
    this.refused = this.refused.filter((p) => !parked.includes(p))
    this.entry = { ...this.entry, requeuedRefused: this.entry.requeuedRefused?.filter((at) => !markers.has(at)) }
    this.writeCache()
    this.emitRefused()
    await this.flush()
  }

  /** Saves refused because the Einsatz was closed — parked until it runs again (see parkRefused). */
  get refusedCount(): number {
    return this.ownRefused().length
  }

  /** The refused saves for «Einträge sichern» — a copy; exporting acknowledges nothing. */
  refusedRecoveryData(): RefusedWorkspace[] {
    return structuredClone(this.ownRefused())
  }

  /**
   * The accounts OTHER than the signed-in one whose unsent work for this Einsatz is parked on this
   * device (ownerCacheKey), as it changes: read on subscribing — init() has parked by then — and
   * again after the slot probe parks another owner’s draft. For the one
   * Meldeleiste row that says so (sweep 09.11.2026, UX.2). ⚠️ It reads the KEYS only: a parked
   * copy is never opened across owners, and nothing here moves or deletes one. Returns the
   * unsubscribe.
   */
  subscribeForeignParked(listener: (owners: string[]) => void): () => void {
    this.foreignParkedListeners.add(listener)
    void this.announceForeignParked()
    return () => { this.foreignParkedListeners.delete(listener) }
  }

  private async announceForeignParked() {
    if (!this.foreignParkedListeners.size) return
    const prefix = ownerCacheKey(this.incidentId, '')
    const keys = await idbKeys(prefix)
    if (!keys.ok || this.disposed) return
    const owners = (keys.value ?? []).map((k) => k.slice(prefix.length))
      .map((slot) => slot.startsWith(quotaPrefix) ? slot.slice(quotaPrefix.length) : slot)
      // the orphan, refused and role slots share the prefix; my own parked copy is mine to re-home
      .filter((owner) => owner && !owner.startsWith('__') && owner !== cacheOwner)
    for (const l of [...this.foreignParkedListeners]) l([...new Set(owners)])
  }

  /** How many saves of a wider role are parked for this owner (roleCacheKey), as it changes.
   *  Subscribing reads the slot, so a reload still counts what an earlier session parked.
   *  Returns the unsubscribe. */
  subscribeRoleParked(listener: (count: number) => void): () => void {
    this.roleParkedListeners.add(listener)
    void idbRead<RefusedWorkspace[]>(roleCacheKey(this.incidentId, this.sessionOwner ?? '')).then((read) => {
      if (!read.ok || !Array.isArray(read.value) || this.disposed) return
      const seen = new Set(this.roleParked.map((r) => r.refusedAt))
      this.roleParked = [...read.value.filter((r) => !seen.has(r.refusedAt)), ...this.roleParked]
      this.emitRoleParked()
    })
    return () => { this.roleParkedListeners.delete(listener) }
  }

  private emitRoleParked() {
    if (this.disposed) return
    for (const l of [...this.roleParkedListeners]) l(this.roleParkedCount)
  }

  get roleParkedCount(): number {
    return this.sessionActive ? this.roleParked.length + this.ownRefused('role').length : 0
  }

  /** The parked saves of a wider role for «Einträge sichern» — a copy; exporting acknowledges nothing. */
  roleParkedRecoveryData(): RefusedWorkspace[] {
    return this.sessionActive ? structuredClone([...this.roleParked, ...this.ownRefused('role')]) : []
  }

  /**
   * Adopt a server revision the app fetched out-of-band (the live-follow poll), rebasing
   * our cache onto it so the NEXT local edit pushes at the right base_rev instead of 409ing.
   * Drops any local dirty state, so callers must only adopt when not dirty — the live-follow
   * poll gates on `!hasUnsynced` for exactly this reason. Keeping every (non-editing) device
   * rebased on the latest rev also means genuine conflicts only arise on truly simultaneous
   * edits, not on a stale base.
   */
  adoptServer(workspace: Workspace, rev: number) {
    if (!this.sessionActive) return
    this.pendingViewMerge = null
    this.reportRenumbered(this.viewState, workspace, 'adopt')
    this.viewState = workspace
    this.entry = { workspace, base: workspace, baseRev: rev, dirty: false, lastSyncedAt: Date.now(), owner: cacheOwner ?? this.entry.owner, requeuedRefused: this.entry.requeuedRefused, quotaReceipt: this.entry.quotaReceipt }
    this.writeCache()
    this.opts.onRev?.(rev)
    this.setStatus('synced')
  }

  get workspace(): Workspace {
    return this.entry.workspace
  }
  get rev(): number {
    return this.entry.baseRev
  }
  get hasUnsynced(): boolean {
    return this.entry.dirty
  }
  get syncStatus(): SyncStatus {
    return this.status
  }
  /** epoch ms of the last successful server sync, or null if never synced this session. */
  get lastSyncedAt(): number | null {
    return this.entry.lastSyncedAt
  }

  dispose() {
    this.flushCache() // land the last edit before the debounce is torn down with the instance
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.probeTimer) clearTimeout(this.probeTimer)
    if (this.refetchTimer) clearTimeout(this.refetchTimer)
  }
}
