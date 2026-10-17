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

/** The checklist taken without asking «Welche Checkliste?», or null to ask. One checklist (or none)
 *  needs no question — unless it is already completed at this stop («Weitere Checkliste» must not
 *  silently repeat it). A checklist ASKED for up front (`?checkliste=`, the Karte's «Melden») is
 *  taken when the catalogue has it; when it does not, the question is asked — the station's one
 *  other checklist («Kontrolle Schlüsselhülse») is never started in its place. */
export function autoChoice(s: {
  asked: string | null
  templates: readonly VisitTemplate[]
  doneHere: ReadonlySet<string | null>
}): { t: VisitTemplate | null } | null {
  if (s.asked) {
    const t = s.templates.find((x) => x.id === s.asked)
    return t ? { t } : null
  }
  return s.templates.length <= 1 && !s.doneHere.has(s.templates[0]?.id ?? null) ? { t: s.templates[0] ?? null } : null
}
