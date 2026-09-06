import { ApiError } from './api'
import { ingestEvents, ingestEventsBeacon, type ClientEvent } from './api/events'
import { idbGet, idbSet } from './idb'
import type { SyncStatus } from './api/workspaceSync'

export type PendingAuditEvent = ClientEvent & { client_id: string }
interface StoredAuditEvents { pending: PendingAuditEvent[]; rejected: PendingAuditEvent[] }
const BATCH_SIZE = 100
const RETRY_MS = 8_000

/** A per-incident, per-actor outbox. Only acknowledged events leave it; beacons are hints.
 *  The incident tab lock grants write ownership, and another login uses another cache key. */
export class AuditEventStore {
  private state: StoredAuditEvents = { pending: [], rejected: [] }
  private loaded: Promise<void> | null = null
  private hydrated = false
  private writeSeq = 0
  private writing: Promise<void> | null = null
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private singleMode = false
  private durable = true
  private failure: 'offline' | 'error' | null = null
  private onChange?: () => void

  constructor(private incidentId: string, private ownerId: string, private readOnly: boolean) {}

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
          for (const key of rejected.keys()) pending.delete(key)
          this.state = { pending: [...pending.values()], rejected: [...rejected.values()] }
        }
        if (this.loaded === opening) this.hydrated = true
        this.onChange?.()
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
    if (!this.writable || (!this.pendingCount && !this.rejectedCount)) return
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
    void this.load().then(() => { if (this.writable) void this.flush() })
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
      void this.load().then(() => { if (this.writable) void this.flush() })
    }
  }

  append(event: PendingAuditEvent) {
    if (!this.writable) return
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
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, ms)
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.drain().finally(() => {
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
          this.onChange?.()
          return
        }
        // Isolate a rejected event without wedging valid events behind it. Keep it for
        // diagnosis and expose rejectedCount; never silently trim an offline backlog.
        if (batch.length > 1) { this.singleMode = true; continue }
        this.state = {
          pending: this.state.pending.filter((e) => e.client_id !== batch[0].client_id),
          rejected: [...this.state.rejected, batch[0]],
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

  /** An explicit retry keeps the original identities; server deduplication still applies. */
  async retry(): Promise<void> {
    await this.hydrate()
    if (!this.writable) return
    await this.flushing
    if (!this.writable) return
    this.state = { pending: [...this.state.pending, ...this.state.rejected], rejected: [] }
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
  get cacheDurable() { return this.durable }
  get status(): SyncStatus {
    if (!this.durable && (this.pendingCount || this.rejectedCount)) return 'storage'
    if (this.rejectedCount) return 'error'
    return this.pendingCount ? (this.failure ?? 'pending') : 'synced'
  }
}
