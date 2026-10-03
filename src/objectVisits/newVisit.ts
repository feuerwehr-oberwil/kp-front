// What `/besuche/neu?object=…&ref=…` does, as one decision (NewVisit renders it). Pure.
//
// The draft of this device and person for (object, workRef) wins over a new id; a new one is
// minted only when the device list could be READ — a failed read is not «no draft», and minting
// then would leave a second draft beside the one that could not be read.

import type { LocalVisit } from './store'
import type { CatalogueObject, VisitTemplate } from './types'

export type NewVisitStep =
  | { kind: 'wait' }
  | { kind: 'resume'; id: string }
  | { kind: 'storage' }
  | { kind: 'notPrepared' }
  | { kind: 'unknown' }
  | { kind: 'openLast'; id: string }
  | { kind: 'readOnly' }
  | { kind: 'choose' }
  | { kind: 'create'; template: VisitTemplate | null }

export function decideNewVisit(s: {
  localsLoaded: boolean
  localsOk: boolean
  catalogueLoaded: boolean
  hasCatalogue: boolean
  object: CatalogueObject | null
  draft: LocalVisit | null
  canCapture: boolean
  choice: { t: VisitTemplate | null } | null
}): NewVisitStep {
  if (!s.localsLoaded || !s.catalogueLoaded) return { kind: 'wait' }
  if (s.draft) return { kind: 'resume', id: s.draft.doc.id }
  if (!s.localsOk) return { kind: 'storage' }
  if (!s.hasCatalogue) return { kind: 'notPrepared' }
  if (!s.object) return { kind: 'unknown' }
  if (!s.canCapture) return s.object.lastVisit ? { kind: 'openLast', id: s.object.lastVisit.id } : { kind: 'readOnly' }
  if (!s.choice) return { kind: 'choose' }
  return { kind: 'create', template: s.choice.t }
}
