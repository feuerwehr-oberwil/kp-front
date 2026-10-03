// Objektbesuche — the shapes of the contract (docs/object-visits.md). The document is what the
// device PUTs as `doc`; the server adds its own fields on every read. Nothing here is behaviour.

import type { ChecklistTemplate, ItemInput } from '../lib/checklists'

export const VISIT_SCHEMA = 'kp-front.object-visit/1' as const

export type Lifecycle = 'draft' | 'completed' | 'discarded'

export type { ItemInput }

/** A checklist snapshot as the visit carries it: the whole template at the time of the visit. */
export type VisitTemplate = ChecklistTemplate

/** `answers[itemId]`. `v` per input: check `ok|defect|na`, yesno `yes|no`, text string, number
 *  number, choice option id, photo `"photo"`. A missing key is «nicht geprüft», never «Nein». */
export interface Answer {
  v: string | number
  /** a `defect` answer's note */
  note?: string
}

export interface ObjectRef { source: string; id: string }

/** The object snapshot the visit carries (display data as it was on the day). */
export interface VisitObject {
  id: string
  name: string
  address?: string | null
  folder?: string | null
  refs?: ObjectRef[]
}

export interface VisitPhoto {
  id: string
  caption: string
  /** the checklist item this photo documents, or absent for «Allgemein» */
  item?: string | null
  sha256: string
  size: number
  type: string
}

export interface VisitProposal {
  id: string
  /** the station's field id (`objectVisits.proposalFields`), or `other` */
  field: string
  label: string
  current?: string | null
  proposed: string
  reason?: string | null
  base?: { source: string; asOf?: string | null } | null
}

/** One unresolved merge, kept in the document until somebody taps an answer
 *  (client bookkeeping; the server stores it opaquely). */
export interface VisitConflict {
  id: string
  /** what collided: `notes`, `visitedAt`, `with`, `checklist`, `workRef`, `object`,
   *  `answers.<itemId>`, `photos.<attId>`, `proposals.<proposalId>` */
  key: string
  /** this device's value (undefined/null = it removed it) */
  mine: unknown
  /** the value the server held and that is in the document now */
  theirs: unknown
  at: string
  /** who and which device met the collision — `mine` is THEIR value. The card is labelled
   *  relative to whoever reads it (StateCards): on another device «Meine» would be a lie. */
  by?: string | null
  device?: string | null
}

export interface VisitDoc {
  schema: typeof VISIT_SCHEMA
  id: string
  object: VisitObject
  workRef?: string | null
  visitedAt: string
  with?: string[]
  lifecycle: Lifecycle
  checklist: VisitTemplate | null
  answers: Record<string, Answer>
  notes: string
  photos: VisitPhoto[]
  proposals: VisitProposal[]
  conflicts?: VisitConflict[]
}

export interface Person { id?: string | null; name?: string | null }

export interface Delivery {
  destination: string
  state: 'pending' | 'delivered' | 'failed' | 'paused'
  revision: number | null
  at?: string | null
  error?: string | null
}

/** What the server adds on read. */
export interface VisitServerFields {
  revision: number
  ready: boolean
  missing: string[]
  createdBy?: Person | null
  createdAt?: string | null
  updatedAt?: string | null
  updatedBy?: Person | null
  findings?: number
  url?: string | null
  deliveries?: Delivery[]
}

export type ServerVisit = VisitDoc & VisitServerFields

/** One row of `GET /api/object-visits/?…` (newest first). */
export interface VisitSummary {
  id: string
  objectId: string
  objectName: string
  workRef?: string | null
  lifecycle: Lifecycle
  revision: number
  ready: boolean
  visitedAt: string
  updatedAt?: string | null
  by?: Person | string | null
  findings?: number
}

export interface Revision {
  revision: number
  lifecycle: Lifecycle
  acceptedAt: string
  acceptedBy?: Person | string | null
  ready: boolean
}

export interface CatalogueObject {
  id: string
  name: string
  address?: string | null
  lat?: number | null
  lng?: number | null
  folder?: string | null
  refs?: ObjectRef[]
  hasPlans?: boolean
  lastVisit?: { id: string; visitedAt: string; lifecycle: Lifecycle } | null
}

export interface VisitList {
  ref: string
  title: string
  note?: string | null
  closesAt?: string | null
  objectIds: string[]
  unresolved?: ObjectRef[]
}

export interface ProposalField { id: string; label: string }

export interface Catalogue {
  generatedAt: string
  canCapture: boolean
  objects: CatalogueObject[]
  templates: VisitTemplate[]
  lists: VisitList[]
  proposalFields: ProposalField[]
}

/** PUT answer: accepted (`200`). */
export interface PutAccepted {
  revision: number
  ready: boolean
  missing: string[]
  visit: ServerVisit
}

// --- admin -----------------------------------------------------------------------------

export interface DeliveryRow {
  destination: string
  visitId: string
  objectName: string
  wantedRevision: number | null
  deliveredRevision: number | null
  state: 'pending' | 'delivered' | 'failed' | 'paused'
  attempts: number
  nextAttemptAt?: string | null
  lastError?: string | null
  updatedAt?: string | null
}

/** A person's display name from either shape the server may send. */
export function personName(p: Person | string | null | undefined): string {
  if (!p) return ''
  return typeof p === 'string' ? p : p.name ?? ''
}
