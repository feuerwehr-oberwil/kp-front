// Objektbesuche — the shapes of the contract (docs/object-visits.md). The document is what the
// device PUTs as `doc`; the server adds its own fields on every read. Nothing here is behaviour.
// The document is the client's own type; every server answer is read off the generated schema
// (backend/app/object_visit_schemas.py → docs/openapi.json → lib/api/schema.d.ts).

import type { components } from '../lib/api/schema'
import type { CachedWithout } from '../lib/api/wire'
import type { ChecklistTemplate, ItemInput } from '../lib/checklists'

type Schemas = components['schemas']

/** An Objektbesuche answer as the server sends it. Unlike `Out` (lib/api/wire.ts), a field the
 *  schema marks optional may be ABSENT: these routes answer with `response_model_exclude_unset`. */
type Sent<N extends keyof Schemas> = Schemas[N]

/** A model that passes the document through (`extra="allow"`), without that index signature. */
type Named<T> = { [K in keyof T as string extends K ? never : K]: T[K] }

/** `T` with its keys `K` typed by the client instead. Unlike `Omit`, `K` must exist in `T`, so a
 *  key renamed on the server fails tsc here too. */
type Retyped<T, K extends keyof T, R extends Record<K, unknown>> = Omit<T, K> & R

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

export type Person = Sent<'ObjectVisitPersonOut'>

export type Delivery = Sent<'ObjectVisitDeliveryOut'>

/** What the server adds on read. All but `revision`/`ready`/`missing` may be absent: a replayed
 *  PUT answer is the one an older server stored. */
export type VisitServerFields = Named<Sent<'ObjectVisitOut'>>

export type ServerVisit = VisitDoc & VisitServerFields

/** One destination's filing of a visit, as the admin list reports it. */
export type VisitFiling = Sent<'ObjectVisitFilingOut'>

/** One row of `GET /api/object-visits/?…` (newest first). Cached on the device: a list from an
 *  older server lacks `target_kind` (an object visit), `location`, `with` and `checklist`. */
export type VisitSummary = CachedWithout<Sent<'ObjectVisitSummaryOut'>, 'target_kind' | 'location' | 'with' | 'checklist'> & {
  /** ADMIN list only: where the visit was filed, per destination */
  deliveries?: AdminVisitSummary['deliveries']
}

/** One row of `GET /api/admin/object-visits`: the summary plus where the visit was filed. */
export type AdminVisitSummary = Sent<'ObjectVisitAdminSummaryOut'>

/** «Neuer Objektbesuch» — every active account, whether it is told and how many of its browsers can receive a push. */
export type NotifyState = Sent<'ObjectVisitNotifyOut'>

export type Revision = Sent<'ObjectVisitRevisionOut'>

export type CatalogueObject = Sent<'ObjectVisitCatalogueObjectOut'>

/** A completion the ORGANIZER already holds for a stop (e.g. the last round in SchlüHü). Shown
 *  as done — never turned into a visit; a real visit for the list always wins. `at` is YYYY-MM-DD. */
export type PriorDone = Sent<'ObjectVisitPriorDoneOut'>

/** A work list. Cached on the device: one from an older server lacks `scheduledOn`, `archived`
 *  and `done` (object id → the organizer's prior completion). */
export type VisitList = CachedWithout<Sent<'ObjectVisitListOut'>, 'scheduledOn' | 'archived' | 'done'>

export type ProposalField = Sent<'ObjectVisitProposalField'>

/** The server types the templates only as objects; they are checklist templates (lib/checklists). */
export type Catalogue = Retyped<Sent<'ObjectVisitCatalogueOut'>, 'templates' | 'lists', {
  templates: VisitTemplate[]
  lists: VisitList[]
}>

/** PUT answer: accepted (`200`). */
export type PutAccepted = Retyped<Sent<'ObjectVisitPutOut'>, 'visit', { visit: ServerVisit }>

// --- admin -----------------------------------------------------------------------------

export type DeliveryRow = Sent<'ObjectVisitDeliveryRowOut'>

export type RetryAnswer = Sent<'ObjectVisitRetryOut'>

export type DestinationTest = Sent<'ObjectVisitDestinationTestOut'>

/** A person's display name from either shape the server may send. */
export function personName(p: Person | string | null | undefined): string {
  if (!p) return ''
  return typeof p === 'string' ? p : p.name ?? ''
}
