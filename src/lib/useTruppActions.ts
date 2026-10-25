import { truppActionCore, type TruppActionDeps } from './truppActions/core'
import { truppClockActions } from './truppActions/clock'
import { truppColorActions } from './truppActions/colors'
import { truppPlacementActions } from './truppActions/placement'
import { truppLineActions } from './truppActions/lines'
import { truppLifecycleActions } from './truppActions/lifecycle'

export { handOrder, nextTruppOrder, truppEditChanges, truppOrderKey } from './truppActions/lifecycle'

/** placement-target id for the Lage map in the «Wohin platzieren?» picker (vs. a plan id) */
export const LAGE_TARGET = 'lage'

/**
 * Atemschutzüberwachung (SCBA monitoring) Trupp mutations — lifted out of App's god-component.
 * Each handler updates the trupps array + the plan board, writes the Verlauf line, and emits an
 * audit event. `trupps`/`setTrupps` stay in IncidentWorkspace (they ride the persistence blob +
 * hydrate + multiple components) and are passed in.
 *
 * The handlers live in families under lib/truppActions, each with its own small Deps, over the
 * shared undo plumbing (`core`): `clock` (Kontakt, Druck, status, Notfall, alarm rows),
 * `lifecycle` (register, edit, re-deploy, transfer, order, remove / restore), `placement` (plan
 * chip / Lage marker), `lines` (the Trupp ⇄ Leitung link) and `colors`. This composes them into
 * the one object every caller has always received.
 */
export function useTruppActions(deps: TruppActionDeps) {
  const core = truppActionCore(deps)
  const clock = truppClockActions({ ...deps, ...core })
  const colors = truppColorActions(deps)
  // placement ⇄ lines call each other (a link settles the crew's marker at the hose end; adopting
  // or releasing a marker takes its hose along), so placement reaches `lines` late — only ever
  // from a tap or a confirm, long after this function has returned.
  const placement = truppPlacementActions({
    ...deps, ...core, teamColor: colors.teamColor, setTruppStatus: clock.setTruppStatus,
    linkTruppLine: (truppId, lineId) => lines.linkTruppLine(truppId, lineId),
    unlinkTruppLine: (truppId) => lines.unlinkTruppLine(truppId),
  })
  const lines = truppLineActions({ ...deps, ...core, placeTruppOnMap: placement.placeTruppOnMap, placeTruppOnPlan: placement.placeTruppOnPlan })
  const lifecycle = truppLifecycleActions({
    ...deps, ...core, dropPlacements: placement.dropPlacements, syncPlacementLabel: placement.syncPlacementLabel,
    recolorPlacement: colors.recolorPlacement, clearLineAnchor: lines.clearLineAnchor,
  })

  const { updateTrupp } = core
  const { recordContact, recordPressure, setTruppStatus, triggerNotfall, endNotfall, truppPlace, logTruppAlarm, logTruppAlarmCleared } = clock
  const { createTrupp, moveTrupp, editTrupp, setTruppEquipment, transferOutOfTrupp, reactivateTrupp, deleteTrupp, restoreTrupp } = lifecycle
  const { placeTruppOnPlan, placeTruppOnMap, adoptTruppMarker, releaseTruppMarker, askTruppEntry, focusTruppOnPlan } = placement
  const { linkTruppLine, linkLineToAttachedTrupp, unlinkLineFromDetachedTrupp, unlinkTruppLine, unlinkLine, syncLineNoToTrupp, showTruppLine, truppsWithLine, truppLineNos } = lines
  const { truppColors } = colors
  return { createTrupp, updateTrupp, moveTrupp, placeTruppOnPlan, placeTruppOnMap, adoptTruppMarker, releaseTruppMarker, askTruppEntry, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, triggerNotfall, endNotfall, truppPlace, editTrupp, setTruppEquipment, transferOutOfTrupp, reactivateTrupp, logTruppAlarm, logTruppAlarmCleared, deleteTrupp, restoreTrupp, linkTruppLine, linkLineToAttachedTrupp, unlinkLineFromDetachedTrupp, unlinkTruppLine, unlinkLine, syncLineNoToTrupp, showTruppLine, truppsWithLine, truppLineNos, truppColors }
}
