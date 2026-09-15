import { appConfig } from '../config/appConfig'
import { Sheet } from '../lib/overlays'
import type { ObjectWithPlans } from '../lib/incidents'
import { ObjectEditor } from './ObjectEditor'
import './stationData.css'

// A `Sheet` around the shared Einsatzobjekt editor — and nothing else.
//
// The editor itself (fields, id derivation, pull notes, Modul-PDF slots, the autosave) lives in
// `ObjectEditor`, because the Objektpläne detail page renders the SAME body inline: the object
// is edited on its own page, not in a modal over a list. This wrapper is what is left for the
// one surface that still asks in a sheet — `DataView · ObjectsView`.
//
// ⚠️ No «Abbrechen» in the footer. The body commits itself, per half: an existing object's
// fields write themselves on blur/debounce, a new one is minted by «Objekt erstellen», and every
// PDF upload is its own write — so there is nothing a cancel could take back; the footer only
// closes.

// Re-exported for the callers that still address them here: `ChecklistsView` wears the same
// provenance badge, and the tests exercise the pure halves.
export { planSlots, parseCoords, PlanSourceBadge } from './ObjectEditor'

export function ObjectSheet({ object, onClose, onChanged }: {
  /** null = create a new Einsatzobjekt */
  object: ObjectWithPlans | null
  onClose: () => void
  /** called after every server write, so the list + map behind the sheet stay true */
  onChanged: (obj: ObjectWithPlans) => void
}) {
  const C = appConfig.copy.admin.objects
  // Deliberately NOT `fit`: the body is a form that GROWS — the plan half only appears once the
  // object exists, and every module adds a slot row. Hugging the content would make the frame
  // jump from short to full the moment «Speichern» lands, which is exactly what the fixed
  // 800px frame is there to prevent.
  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={object ? C.editTitle : C.newTitle}
      sheetClassName="adm-objsheet"
      footer={<button type="button" className="ip-btn" onClick={onClose}>{C.close}</button>}
    >
      <ObjectEditor object={object} onChanged={onChanged} />
    </Sheet>
  )
}
