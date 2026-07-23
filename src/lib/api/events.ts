// Audit/event ingestion + hash-chain verification for an incident (the append-only record).
import { apiBeacon, apiGet, apiPost } from '../api'

export interface ClientEvent {
  op_type: string
  payload?: Record<string, unknown>
  occurred_at?: string
}
export const ingestEvents = (id: string, events: ClientEvent[]) =>
  apiPost(`/api/incidents/${id}/events`, { events })
/** Fire-and-forget event ingest for page teardown — survives the document unloading. */
export const ingestEventsBeacon = (id: string, events: ClientEvent[]) =>
  apiBeacon(`/api/incidents/${id}/events`, { events })
export const verifyChain = (id: string) =>
  apiGet<{ intact: boolean; broken_at_seq: number | null; count: number; head?: string }>(`/api/incidents/${id}/verify`)
