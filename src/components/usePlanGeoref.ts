// «Karte verknüpfen» on the Plan: the chip's reading, arming the point flow,
// the Passung and its transfer to a sibling Modul — everything about tying THIS sheet to the map
// that lives in the board, not in the mode store. Lifted out of the Whiteboard (sweep A.1,
// 25.10.2026); the fit itself is solved by the Whiteboard before its measuring hook (a linked
// sheet measures through it), and the pairing mode lives in lib/georefMode. docs/plans-and-buildings.md.

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { PlanDocument } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import type { fitSimilarity } from '../lib/georef'
import { incidentBindingApproved } from '../lib/incidentPlanBindings'
import { georefForPlan } from '../lib/stationPlanScale'
import { georefChip, georefDispatch, setGeorefSaveErrorHandler, startGeorefMode, transferGeorefPlan, type GeorefModeState } from '../lib/georefMode'
import type { GeorefTransferTarget } from './GeorefTransfer'

interface Args {
  plans: PlanDocument[]
  active: PlanDocument
  /** the Modul slot on the rail … */
  activeId: string
  /** … and THE SHEET it shows, which the reference is stored under (Whiteboard · activeGeorefKey) */
  activeGeorefKey: string
  /** the cross-surface pairing mode (lib/georefMode · useGeorefMode), and whether it is armed here */
  georef: GeorefModeState
  georefArmed: boolean
  /** the pairs in force (live while armed, else stored) and the fit solved from them */
  georefPairs: GeorefModeState['pairs']
  georefFit: ReturnType<typeof fitSimilarity>
  /** a printed sheet that can carry a reference at all (not the Tafel, OSM, a viewer PDF or a stack) */
  canGeoref: boolean
  readOnly: boolean
  /** an Einsatz-Link session: the origin's instruments, never shown */
  linkViewer: boolean
  measureAR: number
  /** the board, whose first canvas is the plan bitmap «Deckung prüfen» shows on the map */
  boardRef: React.RefObject<HTMLDivElement | null>
}

/** The Plan's «Karte verknüpfen» workflow; see the file header. Called where its effects used to
 *  run in the Whiteboard (after the measuring hook, before the document-switch reset). */
export function usePlanGeoref({
  plans, active, activeId, activeGeorefKey, georef, georefArmed, georefPairs, georefFit, canGeoref, readOnly, linkViewer,
  measureAR, boardRef,
}: Args) {
  // WHICH plan the Passung is open for, not merely whether it is open: switching documents then
  // closes it by derivation instead of by an effect that fires after the wrong panel has already
  // been painted over the new sheet.
  const [qualityFor, setQualityFor] = useState<string | null>(null)
  // The pairing mode itself lives in lib/georefMode — outside React, because on a phone this
  // component is unmounted between the plan tap and the map tap (see that file's header).
  // Which surfaces can carry a georeference at all: a printed sheet can. The Tafel has no
  // geometry to tie down, the OSM picking face IS the map, a viewer-only PDF is not annotated,
  // and the Gebäude floor stack is a COLUMN of copies of one footprint — one similarity
  // transform cannot mean anything across it (georef.ts · «tile-locally», not built here).
  // ⚠️ …and whether the station APPROVED this sheet's fit (incidentPlanBindings ·
  // incidentBindingApproved): an approved fit is a linked one, in the same tone a hand-measured
  // reference wears — see georefMode · georefChip (18.09.2026).
  const georefApproved = incidentBindingApproved(activeGeorefKey)
  const georefState = georefChip(georefFit, georef, activeId, georefPairs, georefApproved)
  /** the «⌖ Karte» chip stands in the pill row (editors; a locked session only once it is linked) */
  const georefChipShown = canGeoref && (!readOnly || georefState.kind === 'linked') && !linkViewer
  /** The real plan bitmap for «Deckung prüfen». The PDF viewport already rendered it into its
   *  first canvas, so taking a same-origin snapshot is both cheaper and more faithful than
   *  rendering the PDF a second time on the map side. It rides in the cross-surface mode store,
   *  which also keeps it alive while the Whiteboard is unmounted on a phone. */
  const georefPreviewUrl = () => {
    const canvas = boardRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas?.width || !canvas.height) return null
    try { return canvas.toDataURL('image/jpeg', 0.82) } catch { return null }
  }
  const beginGeoref = (opts?: { check?: boolean; returnToQuality?: boolean }) => startGeorefMode(activeId, measureAR, {
    storageKey: activeGeorefKey,
    check: opts?.check,
    returnToQuality: opts?.returnToQuality,
    previewUrl: georefPreviewUrl(),
  })
  const georefQuality = qualityFor === activeId
  const [georefTransferOpen, setGeorefTransferOpen] = useState(false)
  const georefPanelPlan = useRef(activeId)
  // These overlays describe one concrete document. A real document switch closes them for good;
  // merely hiding them and reopening the old state when the operator later returns is dangerous
  // because transfer would then act on a source they are no longer looking at.
  useEffect(() => {
    if (georefPanelPlan.current === activeId) return
    georefPanelPlan.current = activeId
    setQualityFor(null)
    setGeorefTransferOpen(false)
  }, [activeId])
  // A coverage check opened from Passung keeps its mode alive just long enough for the phone to
  // navigate back from Karte and mount this surface again. Restore the panel, then retire that
  // temporary mode; on desktop the same transition is immediate and produces identical UI.
  useEffect(() => {
    if (!georefArmed || georef.check || georef.checkReturn !== 'quality') return
    setQualityFor(activeId)
    georefDispatch({ type: 'dismiss' })
  }, [activeId, georefArmed, georef.check, georef.checkReturn])
  // Only object-specific Modul sheets receive a `georefKey`; this excludes Tafel, OSM and
  // generic PDFs without guessing from their labels. Sibling Modules describe the same object
  // area, which is exactly the case where copying a fit is meaningful.
  const georefTransferTargets: GeorefTransferTarget[] = active?.georefKey
    ? plans
      .filter((p) => p.id !== activeId && !!p.georefKey && p.viewer !== true && !!p.imageUrl && !p.osm && !p.floorStack)
      .map((plan) => ({ plan, linked: !!georefForPlan(plan.georefKey!)?.pairs.length }))
    : []
  const transferGeoref = async (target: GeorefTransferTarget) => {
    const C = appConfig.copy.whiteboard.georef
    const targetKey = target.plan.georefKey
    if (!targetKey) return false
    if (target.linked) {
      const replace = await confirmDialog({
        title: fillTemplate(C.transferReplaceTitle, { target: target.plan.code }),
        message: fillTemplate(C.transferReplaceBody, { target: target.plan.code, source: active?.code ?? activeId }),
        confirmLabel: C.transfer,
        cancelLabel: C.cancel,
      })
      if (!replace) return false
    }
    try {
      const copied = await transferGeorefPlan(activeGeorefKey, targetKey)
      if (!copied) return false
      toast(fillTemplate(C.transferDone, { target: target.plan.code }))
      return true
    } catch {
      toast(C.saveFailed, { icon: 'warn', tone: 'warn' })
      return false
    }
  }
  // an offline PUT must not lose the pairs: they stay in the store and the next save writes the
  // whole list again (saveGeoref replaces the document), so the retry needs no queue of its own
  useEffect(() => {
    setGeorefSaveErrorHandler(() => toast(appConfig.copy.whiteboard.georef.saveFailed, { icon: 'warn', tone: 'warn' }))
    return () => setGeorefSaveErrorHandler(null)
  }, [])
  // switching to another plan document ends the mode — the references belong to ONE sheet, and
  // a half-placed pair carried onto a different one would be nonsense
  useEffect(() => {
    if (georef.planId && georef.planId !== activeId) georefDispatch({ type: 'dismiss' })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    georefApproved, georefState, georefChipShown, beginGeoref,
    qualityFor, setQualityFor, georefQuality, georefTransferOpen, setGeorefTransferOpen, georefTransferTargets, transferGeoref,
  }
}
