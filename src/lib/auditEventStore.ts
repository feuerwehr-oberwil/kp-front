import { ApiError, isUnverifiable } from './api'
import { ingestEvents, ingestEventsBeacon, type ClientEvent } from './api/events'
import { idbGet, idbSet } from './idb'
import { ALL_EVENTS, type EventScope } from './eventScope'
import type { SyncStatus } from './api/workspaceSync'

export type PendingAuditEvent = ClientEvent & { client_id: string }
/**
 * `refused` (24.09.2026) is the third bucket beside pending and rejected: events the server
 * answered 403 for AND that this session's role can never write (`eventScope`). They are not
 * owed — no retry can ever deliver them, and holding the shared sync status red for them told
 * an `el` phone for three hours that its record was not saved when it was. They are PARKED,
 * never dropped: persisted with the outbox and carried by `getRecoveryData` («Einträge
 * sichern»). A 403 for an op the role SHOULD be able to write stays `rejected` — that is a
 * real mismatch somebody has to see. Absent in caches written before the bucket existed.
 */
interface StoredAuditEvents { pending: PendingAuditEvent[]; rejected: PendingAuditEvent[]; refused?: PendingAuditEvent[] }
const BATCH_SIZE = 100
const RETRY_MS = 8_000

/** A per-incident, per-actor outbox. Only acknowledged events leave it; beacons are hints.
 *  The incident tab lock grants write ownership, and another login uses another cache key. */
export class AuditEventStore {
  private state: StoredAuditEvents = { pending: [], rejected: [], refused: [] }
  private loaded: Promise<void> | null = null
  private hydrated = false
  private writeSeq = 0
  private writing: Promise<void> | null = null
  private flushing: Promise<void> | null = null
  /** somebody asked for a flush while one was in flight — see `flush` */
  private flushRequested = false
  /** the last attempt failed because the server could not be ASKED (api · isUnverifiable) */
  private unreached = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private singleMode = false
  private durable = true
  private failure: 'offline' | 'error' | null = null
  private onChange?: () => void

  constructor(private incidentId: string, private ownerId: string, private readOnly: boolean, private scope: EventScope = ALL_EVENTS) {}

  /** The role may change under a live store (a role edit, a promotion); what it can never
   *  write moves out of the red bucket at once, and nothing moves back in by itself. */
  setScope(scope: EventScope) {
    if (this.scope === scope) return
    this.scope = scope
    if (this.park()) { this.onChange?.(); if (this.writable && this.hydrated) void this.persist() }
  }

  /** Move `rejected` events the scope says this session can never write into `refused` — the
   *  cache an `el` phone carried out of the 23.09.2026 Einsatz holds exactly those. */
  private park(): boolean {
    const refusedNow = this.state.rejected.filter((e) => !this.scope(e.op_type))
    if (!refusedNow.length) return false
    const moved = new Set(refusedNow.map((e) => e.client_id))
    this.state = {
      ...this.state,
      rejected: this.state.rejected.filter((e) => !moved.has(e.client_id)),
      refused: [...(this.state.refused ?? []), ...refusedNow],
    }
    return true
  }

  subscribe(listener: () => void) {
    this.onChange = listener
    return () => { if (this.onChange === listener) this.onChange = undefined }
  }

  private get key() { return `kp-audit-${this.incidentId}:${this.ownerId}` }
  private get writable() { return this.running && !this.readOnly }

  private load(): Promise<void> {
    if (!this.loaded) {
      const opening = idbGet<StoredAuditEvents>(this.key).then((cached) => {
        if (cached) {
          const pending = new Map([...(cached.pending ?? []), ...this.state.pending].map((e) => [e.client_id, e]))
          const rejected = new Map([...(cached.rejected ?? []), ...this.state.rejected].map((e) => [e.client_id, e]))
          const refused = new Map([...(cached.refused ?? []), ...(this.state.refused ?? [])].map((e) => [e.client_id, e]))
          for (const key of refused.keys()) { pending.delete(key); rejected.delete(key) }
          for (const key of rejected.keys()) pending.delete(key)
          this.state = { pending: [...pending.values()], rejected: [...rejected.values()], refused: [...refused.values()] }
        }
        const parked = this.park()
        if (this.loaded === opening) this.hydrated = true
        this.onChange?.()
        // land the reclassification, so an export or the next open reads the same buckets
        if (parked && this.writable) void this.persist()
      })
      this.loaded = opening
    }
    return this.loaded
  }

  /** Promotion can replace a still-pending initial read; wait for the current owner’s read. */
  private async hydrate(): Promise<void> {
    let opening: Promise<void>
    do { opening = this.load(); await opening } while (opening !== this.loaded)
  }

  private writeSnapshot(): Promise<void> {
    const seq = ++this.writeSeq
    // Enqueue the IDB transaction now, while still holding ownership. IDB orders it
    // before the next owner's read; a deferred callback could run after the handover.
    return idbSet(this.key, this.state).then((durable) => {
      if (seq !== this.writeSeq) return
      this.durable = durable
      this.onChange?.()
    })
  }

  private persistBeforeRelease() {
    if (!this.writable || (!this.pendingCount && !this.rejectedCount && !this.refusedCount)) return
    if (this.hydrated) void this.writeSnapshot()
    else {
      // Replacing an unread cache would lose the predecessor's work. Preserve the
      // new event in recovery data and say it is undurable instead of writing blind.
      this.durable = false
      this.onChange?.()
    }
  }

  start() {
    this.running = true
    void this.load().then(() => { if (this.writable) void this.run() })
  }

  stop() {
    this.persistBeforeRelease()
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  setReadOnly(value: boolean) {
    if (this.readOnly === value) return
    if (value) this.persistBeforeRelease()
    this.readOnly = value
    this.generation++
    if (value) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
    } else {
      // A promoted tab must first recover what its predecessor queued while it watched.
      this.loaded = null
      this.hydrated = false
      void this.load().then(() => { if (this.writable) void this.run() })
    }
  }

  append(event: PendingAuditEvent) {
    if (!this.writable) return
    // An op this session's role can never write is not queued at all (24.09.2026): it would
    // only 403. Nothing the record owes is lost — the act is the one that role could not
    // perform, and a system observation (the Atemschutz alarm) is recorded by the devices that
    // may write it, and in the Verlauf by this one.
    if (!this.scope(event.op_type)) return
    this.state = { ...this.state, pending: [...this.state.pending, structuredClone(event)] }
    this.onChange?.()
    void this.persist()
    this.schedule(4_000)
  }

  /** Serialize snapshots, loading the predecessor's outbox before the first write. */
  private persist(): Promise<void> {
    if (this.writing) return this.writing
    this.writing = Promise.resolve().then(async () => {
      await this.hydrate()
      // Coalesce a capture burst into the latest immutable snapshot; if another edit
      // arrives during its transaction, serialize one more write before resolving.
      while (this.writable) {
        const snapshot = this.state
        await this.writeSnapshot()
        if (snapshot === this.state) break
      }
    }).finally(() => { this.writing = null })
    return this.writing
  }

  private schedule(ms: number) {
    if (!this.writable) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.run() }, ms)
  }

  /** ⚠️ A flush asked for WHILE an attempt is in flight is owed its own attempt if that one
   *  fails (the journal's rule, #209): the `online` handler and the reach signal
   *  (lib/connectivity) arrive exactly when a POST sent under the old conditions may still be
   *  settling, and merely joining it left the events for the next RETRY_MS tick. Only a
   *  failure to REACH the server is re-run, once per request, so an offline device does not
   *  spin. The store's own triggers (start, the retry timer) go through `run` and ask for
   *  nothing: they carry no news about the link. */
  flush(): Promise<void> {
    if (this.flushing) this.flushRequested = true
    return this.run()
  }

  private run(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      do {
        this.flushRequested = false
        this.unreached = false
        await this.drain()
      } while (this.flushRequested && this.unreached && this.writable && this.state.pending.length)
    })().finally(() => {
      this.flushing = null
      if (this.state.pending.length) this.schedule(RETRY_MS)
    })
    return this.flushing
  }

  private async drain() {
    await this.hydrate()
    if (!this.writable || !this.state.pending.length) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const generation = this.generation
    while (this.writable && generation === this.generation && this.state.pending.length) {
      await this.persist() // land the IDs and contents before any request can be accepted
      if (!this.writable || generation !== this.generation) return
      const batch = this.state.pending.slice(0, this.singleMode ? 1 : BATCH_SIZE)
      try {
        await ingestEvents(this.incidentId, batch)
        if (!this.writable || generation !== this.generation) return
        const sent = new Set(batch.map((e) => e.client_id))
        this.state = { ...this.state, pending: this.state.pending.filter((e) => !sent.has(e.client_id)) }
        this.failure = null
        if (!this.state.pending.length) this.singleMode = false
      } catch (error) {
        if (!this.writable || generation !== this.generation) return
        const permanent = error instanceof ApiError && [400, 403, 409, 413, 422].includes(error.status)
        if (!permanent) {
          this.failure = error instanceof ApiError && error.status === 0 ? 'offline' : 'error'
          this.unreached = isUnverifiable(error)
          this.onChange?.()
          return
        }
        // Isolate a rejected event without wedging valid events behind it. Keep it for
        // diagnosis and expose rejectedCount; never silently trim an offline backlog.
        if (batch.length > 1) { this.singleMode = true; continue }
        // …and a 403 for an op this role can never write is parked, not held red (see
        // StoredAuditEvents · refused). Anything else refused stays a visible error.
        const notOwed = error instanceof ApiError && error.status === 403 && !this.scope(batch[0].op_type)
        this.state = {
          ...this.state,
          pending: this.state.pending.filter((e) => e.client_id !== batch[0].client_id),
          ...(notOwed
            ? { refused: [...(this.state.refused ?? []), batch[0]] }
            : { rejected: [...this.state.rejected, batch[0]] }),
        }
      }
      this.onChange?.()
      await this.persist()
    }
  }

  flushKeepalive() {
    if (!this.writable) return
    // Normal capture already queued durable writes. Teardown cannot await them, and an
    // unacknowledged keepalive never changes the outbox, even if the server accepted it.
    void this.persist()
    const batch: PendingAuditEvent[] = []
    for (const event of this.state.pending.slice(0, BATCH_SIZE)) {
      if (new TextEncoder().encode(JSON.stringify({ events: [...batch, event] })).byteLength > 48 * 1024) break
      batch.push(event)
    }
    if (batch.length) ingestEventsBeacon(this.incidentId, batch)
  }

  /** An explicit retry keeps the original identities; server deduplication still applies.
   *  `refused` events are NOT re-sent: the role cannot write them, so a retry could only
   *  collect the same 403 again (the 23.09.2026 «Erneut versuchen» loop). */
  async retry(): Promise<void> {
    await this.hydrate()
    if (!this.writable) return
    await this.flushing
    if (!this.writable) return
    this.state = { ...this.state, pending: [...this.state.pending, ...this.state.rejected], rejected: [] }
    this.failure = null
    this.onChange?.()
    await this.persist()
    await this.flush()
  }

  getRecoveryData() {
    return structuredClone({ incidentId: this.incidentId, ownerId: this.ownerId, ...this.state })
  }

  get pendingCount() { return this.state.pending.length }
  get rejectedCount() { return this.state.rejected.length }
  /** parked, not owed — reported for export, never part of the sync status */
  get refusedCount() { return this.state.refused?.length ?? 0 }
  get cacheDurable() { return this.durable }
  get status(): SyncStatus {
    // a refused event still lives only here, so an undurable cache holding one IS the storage
    // warning — parking it takes it out of «not delivered», not out of «not safely kept»
    if (!this.durable && (this.pendingCount || this.rejectedCount || this.refusedCount)) return 'storage'
    if (this.rejectedCount) return 'error'
    return this.pendingCount ? (this.failure ?? 'pending') : 'synced'
  }
}
