// The status line of a visit: three axes, one line (design PLAN §5).
//
//   Lifecycle        Entwurf · Abgeschlossen (· Verworfen)
//   Device → server  Nicht gespeichert · Konflikt · Anmeldung nötig · Nicht gesendet · Wird
//                    gesendet · Nur auf diesem Gerät · Fotos n/m · Gespeichert
//   Server → filing  wartet · abgelegt · Fehler · pausiert — hidden where none is configured
//
// ⚠️ «Gespeichert» means the SERVER holds this device's latest revision AND every photo of it
// (`ready`). A document accepted with photos still missing is «Fotos 2/5», never «Gespeichert».
// Pure: derives from the device record and three facts the caller knows.

import { pendingUploads } from './outbox'
import type { LocalVisit, OutboxError } from './store'
import type { Delivery, Lifecycle, ServerVisit } from './types'

export type SyncKind =
  | 'unsaved'   // the device write failed — this exists only in this window
  | 'conflict'  // «Zwei Fassungen» are waiting for a tap
  | 'auth'      // the session lapsed; the work is kept, sending is paused
  | 'error'     // the server refused (422/403/…): kept, said, not retried until the next edit
  | 'sending'
  | 'local'     // never reached the server (offline, or no save point yet)
  | 'changes'   // the server has an older revision; the newer edits are on this device
  | 'photos'    // the server has the document, not yet all its photos
  | 'saved'
  | 'remote'    // read-only view of a visit this device does not hold

export interface SyncState {
  kind: SyncKind
  /** when the device last stored it / when the server last accepted it */
  at?: string | null
  revision?: number
  photosDone?: number
  photosTotal?: number
  /** the last send failed for want of a network (the line says «offline») */
  offline?: boolean
  error?: OutboxError | null
}

export type DeliveryKind = 'none' | 'waiting' | 'delivered' | 'failed' | 'paused'

export interface DeliveryState {
  kind: DeliveryKind
  revision?: number | null
  error?: string | null
  rows: Delivery[]
}

export interface VisitStatus {
  lifecycle: Lifecycle
  sync: SyncState
  delivery: DeliveryState
}

export function deliveryState(rows: Delivery[] | null | undefined, revision: number | null | undefined): DeliveryState {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return { kind: 'none', rows: [] }
  const failed = list.find((d) => d.state === 'failed')
  if (failed) return { kind: 'failed', error: failed.error ?? null, revision: failed.revision, rows: list }
  if (list.every((d) => d.state === 'paused')) return { kind: 'paused', rows: list }
  const live = list.filter((d) => d.state !== 'paused')
  const delivered = live.every((d) => d.state === 'delivered' && (revision == null || (d.revision ?? 0) >= revision))
  if (delivered) return { kind: 'delivered', revision: Math.min(...live.map((d) => d.revision ?? 0)), rows: list }
  return { kind: 'waiting', rows: list }
}

export function deriveStatus({ rec, durable, flushing, sessionExpired, remote }: {
  rec: LocalVisit | null
  /** the record and its photos are in storage (store · isVisitDurable) */
  durable: boolean
  flushing: boolean
  sessionExpired: boolean
  /** the server's copy, for a visit this device does not hold (a viewer's read view) */
  remote?: ServerVisit | null
}): VisitStatus {
  if (!rec) {
    const v = remote
    return {
      lifecycle: v?.lifecycle ?? 'draft',
      sync: { kind: 'remote', revision: v?.revision, at: v?.updatedAt ?? null },
      delivery: deliveryState(v?.deliveries, v?.revision),
    }
  }
  const doc = rec.doc
  const lifecycle = doc.lifecycle
  const delivery = deliveryState(rec.server?.deliveries, rec.sent?.revision ?? rec.base?.revision)
  const offline = rec.lastError?.kind === 'offline'
  const sync = ((): SyncState => {
    if (!durable) return { kind: 'unsaved', at: rec.savedAt }
    // «Zwei Fassungen» waiting for a tap, or still behind another device after the merge rounds
    if (doc.conflicts?.length || rec.lastError?.kind === 'contended') return { kind: 'conflict', error: rec.lastError }
    const owes = !!rec.op || rec.dirty || !rec.base || pendingUploads(rec).length > 0
    if (rec.lastError?.kind === 'auth' || (sessionExpired && owes)) return { kind: 'auth', error: rec.lastError }
    if (rec.lastError && ['rejected', 'forbidden', 'disabled', 'attachment'].includes(rec.lastError.kind)) {
      return { kind: 'error', error: rec.lastError }
    }
    if (flushing) return { kind: 'sending' }
    if (!rec.base) return { kind: 'local', at: rec.savedAt, offline }
    if (rec.dirty || rec.op) return { kind: 'changes', at: rec.savedAt, offline, revision: rec.base.revision }
    const total = doc.photos.length
    const waiting = new Set([...(rec.sent?.missing ?? []), ...pendingUploads(rec).filter((id) => doc.photos.some((p) => p.id === id))])
    if (waiting.size > 0 || rec.sent?.ready === false) {
      const pending = doc.photos.filter((p) => waiting.has(p.id)).length
      return { kind: 'photos', photosDone: Math.max(0, total - pending), photosTotal: total, offline }
    }
    return { kind: 'saved', revision: rec.base.revision, at: rec.server?.updatedAt ?? rec.savedAt }
  })()
  return { lifecycle, sync, delivery }
}

/** Saved in the strict sense the status line uses. */
export const isSaved = (s: VisitStatus): boolean => s.sync.kind === 'saved'
