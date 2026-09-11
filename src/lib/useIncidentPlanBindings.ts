import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import type { Georef } from './georef'
import { georefDispatch } from './georefMode'
import { effectiveBindingGeoref, overridePlanBinding, registerIncidentPlanBindings, type IncidentPlanBinding } from './incidentPlanBindings'
import type { UndoTimeline } from './undoTimeline'

/** Keeps the shared georef UI attached to this incident's synced, undoable workspace slice. */
export function useIncidentPlanBindings(
  incidentId: string,
  bindings: IncidentPlanBinding[],
  setBindings: Dispatch<SetStateAction<IncidentPlanBinding[]>>,
  readOnly: boolean,
  history: UndoTimeline,
) {
  const latest = useRef(bindings)
  const saveRef = useRef<(id: string, georef: Georef, coalesce?: boolean) => void>(() => {})
  const dragRef = useRef<{ id: string; until: number; override: Georef | undefined; undo: () => boolean } | null>(null)
  useLayoutEffect(() => {
    latest.current = bindings
    saveRef.current = (id, georef, coalesce) => {
      if (readOnly) throw new Error('Incident alignment is read-only')
      const before = latest.current.find((binding) => binding.id === id)
      if (!before) throw new Error('Incident plan binding is unavailable')
      if (JSON.stringify(effectiveBindingGeoref(before)) === JSON.stringify(georef)) return
      const apply = (override: Georef | undefined) => {
        if (!latest.current.some((binding) => binding.id === id)) return false
        // Stored undo must also leave the live pairing mode, whose draft otherwise masks it.
        georefDispatch({ type: 'dismiss' })
        const next = latest.current.map((binding) => binding.id === id ? { ...binding, override } : binding)
        latest.current = next
        setBindings(next)
        return true
      }
      const next = overridePlanBinding(latest.current, id, georef)
      const after = next.find((binding) => binding.id === id)!
      latest.current = next
      setBindings(next)
      const previous = dragRef.current
      if (coalesce && previous?.id === id && Date.now() < previous.until && history.peekUndo()?.undo === previous.undo) {
        previous.override = after.override
        previous.until = Date.now() + 400
        return
      }
      const step = { id, until: Date.now() + 400, override: after.override, undo: () => apply(before.override) }
      dragRef.current = coalesce ? step : null
      history.push({
        domain: 'plan', scope: before.planId,
        label: appConfig.copy.whiteboard.georef.linkTitle,
        undo: step.undo,
        redo: () => apply(step.override),
      })
    }
  })
  useLayoutEffect(() => registerIncidentPlanBindings(incidentId, {
    bindings,
    save: (id, georef, coalesce) => saveRef.current(id, georef, coalesce),
  }), [incidentId, bindings])
}
