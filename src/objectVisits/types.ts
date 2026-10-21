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
  /** where the object is (WGS84), when the catalogue knows it */
  lat?: number | null
  lng?: number | null
}

/** What a visit is AT (docs/object-visits.md · «The target», 16.10.2026): a catalogue object,
 *  or a place — a pin or an address — with no object at all. A document without `target` (an
 *  older one) is at its `object`. */
export type VisitTarget =
  | { kind: 'object'; objectId: string }
  | {
    kind: 'location'
    /** what a person calls the place: «bei Talholzstrasse 15», «Talholzstrasse 15», «Gesetzter Punkt» */
    label: string
    /** the reverse-geocoded / searched address; null when there was none (never blocks a report) */
    address: string | null
    lat: number
    lng: number
  }

export type PlaceTarget = Extract<VisitTarget, { kind: 'location' }>

/** Where a visit was, as the server reports it on every read (contract C2). */
export interface VisitLocation {
  label: string | null
  address: string | null
  lat: number | null
  lng: number | null
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
  /** what collided: `notes`, `visitedAt`, `with`, `checklist`, `workRef`, `object`, `target`,
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
  /** null for a visit at a place (`target.kind === 'location'`) */
  object: VisitObject | null
  target?: VisitTarget
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
  target_kind?: VisitTarget['kind']
  location?: VisitLocation | null
  /** when it was FINISHED — the first revision that said `completed`; null while it is not */
  completedAt?: string | null
  /** from when corrections are refused (objectVisits/lock); null where no lock applies */
  lockedAt?: string | null
}

export type ServerVisit = VisitDoc & VisitServerFields

/** One row of `GET /api/object-visits/?…` (newest first). */
export interface VisitSummary {
  id: string
  /** null for a visit at a place */
  objectId: string | null
  objectName: string | null
  /** absent from an older server: an object visit */
  target_kind?: VisitTarget['kind']
  location?: VisitLocation | null
  workRef?: string | null
  lifecycle: Lifecycle
  revision: number
  ready: boolean
  visitedAt: string
  updatedAt?: string | null
  by?: Person | string | null
  /** «Von» — the people typed on the visit (the account is only the fallback) */
  with?: string[] | null
  findings?: number
  /** the checklist the visit was made with (null: «Ohne Checkliste»; absent from an older server) */
  checklist?: { id: string; title?: string | null } | null
  /** ADMIN list only: where the visit was filed, per destination — state, the folder path below
   *  the library (once the first delivery made it), the error while it fails */
  deliveries?: VisitFiling[]
}

/** One destination's filing of a visit, as the admin list reports it. */
export interface VisitFiling {
  destination: string
  state: DeliveryRow['state']
  revision: number
  at?: string | null
  folder?: string | null
  error?: string | null
}

/** «Neuer Objektbesuch» — every active account, whether it is told and how many of its browsers can receive a push. */
export interface NotifyState {
  pushEnabled: boolean
  accounts: { id: string; name: string; username: string; role: string; notify: boolean; devices: number }[]
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

/** A completion the ORGANIZER already holds for a stop (e.g. the last round in SchlüHü). Shown
 *  as done — never turned into a visit; a real visit for the list always wins. */
export interface PriorDone {
  /** YYYY-MM-DD */
  at: string
  by?: string | null
  /** e.g. «SchlüHü» */
  source?: string | null
  note?: string | null
}

export interface VisitList {
  ref: string
  title: string
  note?: string | null
  closesAt?: string | null
  scheduledOn?: string | null
  archived?: boolean
  objectIds: string[]
  unresolved?: ObjectRef[]
  /** object id → the organizer's prior completion */
  done?: Record<string, PriorDone> | null
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
