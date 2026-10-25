// «Karte verknüpfen» on the Plan: the chip's reading, the chooser with «Automatisch ausrichten»,
// the Passung and its transfer to a sibling Modul — everything about tying THIS sheet to the map
// that lives in the board, not in the mode store. Lifted out of the Whiteboard (sweep A.1,
// 25.10.2026); the fit itself is solved by the Whiteboard before its measuring hook (a linked
// sheet measures through it), and the pairing mode lives in lib/georefMode. docs/plans-and-buildings.md.

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { LngLat, PlanDocument } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { ApiError } from '../lib/api'
import { planMatcherImage, planPrintedMPerU } from '../lib/pdfRaster'
import { planUrl } from '../lib/whiteboard'
import type { fitSimilarity } from '../lib/georef'
import { incidentBindingApproved } from '../lib/incidentPlanBindings'
import { georefForPlan } from '../lib/stationPlanScale'
import { georefChip, georefDispatch, setGeorefSaveErrorHandler, startGeorefMode, startGeorefProposal, transferGeorefPlan, type GeorefModeState } from '../lib/georefMode'
import { georefSuggestEligible, requestGeorefSuggestion, type GeorefSuggestStep } from '../lib/georefSuggest'
import type { GeorefTransferTarget } from './GeorefTransfer'
import type { usePlanMeasure } from './usePlanMeasure'

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
  activeScale: ReturnType<typeof usePlanMeasure>['activeScale']
  /** the matcher's anchor: the active object's coordinate, else the Einsatzort */
  georefAnchor?: LngLat | null
  /** the board, whose first canvas is the plan bitmap «Deckung prüfen» shows on the map */
  boardRef: React.RefObject<HTMLDivElement | null>
}

/** The Plan's «Karte verknüpfen» workflow; see the file header. Called where its effects used to
 *  run in the Whiteboard (after the measuring hook, before the document-switch reset). */
export function usePlanGeoref({
  plans, active, activeId, activeGeorefKey, georef, georefArmed, georefPairs, georefFit, canGeoref, readOnly, linkViewer,
  measureAR, activeScale, georefAnchor, boardRef,
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
  // ── «Automatisch ausrichten» — the CV suggestion path of an unlinked sheet ─────────────────
  // The unlinked chip opens a two-way chooser when the matcher CAN be asked (Modul-2 template,
  // an anchor coordinate, a resolvable calibration); otherwise it arms the point flow directly,
  // exactly as before. The suggestion arrives as a PROPOSAL review on the coverage view —
  // nothing is stored until «Übernehmen» there (lib/georefMode · startGeorefProposal).
  const [linkChoice, setLinkChoice] = useState(false)
  // the phase the busy card names (render → Gebäudedaten → vergleichen); null = not running
  const [autoStep, setAutoStep] = useState<GeorefSuggestStep | null>(null)
  const autoBusy = autoStep != null
  // Token of the CURRENT auto-align run. The matcher takes seconds and a thread cannot be
  // recalled — but its ANSWER can be orphaned: closing the chooser, switching sheets or
  // starting a fresh run bumps the token, so a stale completion can never yank the workspace
  // into a proposal review nobody is waiting for.
  const autoRunRef = useRef(0)
  useEffect(() => { autoRunRef.current++; setLinkChoice(false); setAutoStep(null) }, [activeId])
  // the chooser's ✕ and the phone sheet's push-down: the answer of a run still in flight is orphaned
  const closeLinkChoice = () => { autoRunRef.current++; setAutoStep(null); setLinkChoice(false) }
  // Warm «Plan rendern» — the matcher raster (usually the resident bake, encoded) and the
  // printed-scale read — the moment the chooser opens, so the seconds the operator spends
  // reading the card cover whatever little work remains.
  useEffect(() => {
    if (!linkChoice || !active?.imageUrl) return
    const url = planUrl(active.imageUrl)
    void planMatcherImage(url).catch(() => {})
    void planPrintedMPerU(url).catch(() => {})
  }, [linkChoice]) // eslint-disable-line react-hooks/exhaustive-deps
  const georefAnchorPt = georefAnchor ? { lng: georefAnchor[0], lat: georefAnchor[1] } : null
  const canAutoAlign = !!active?.imageUrl && georefSuggestEligible(activeId, georefAnchorPt)
  const runAutoAlign = async () => {
    if (!georefAnchorPt || !active?.imageUrl || autoBusy) return
    const runId = ++autoRunRef.current
    setAutoStep('render')
    try {
      const out = await requestGeorefSuggestion(
        {
          planUrl: planUrl(active.imageUrl),
          anchor: georefAnchorPt,
          mPerU: activeScale?.mPerU,
          template: activeId.startsWith('modul1') ? 'm1' : 'm2',
        },
        (step) => { if (runId === autoRunRef.current) setAutoStep(step) },
      )
      // the chooser was closed / the sheet switched while the matcher ran — orphaned answer
      if (runId !== autoRunRef.current) return
      if (out.kind !== 'fit') {
        // a normal outcome, not an error: the chooser stays up, «Punkte selbst setzen» is right there
        toast(out.kind === 'noScale' ? appConfig.copy.whiteboard.georef.autoNoScale : appConfig.copy.whiteboard.georef.autoNone, { icon: 'warn', tone: 'warn' })
        return
      }
      setLinkChoice(false)
      startGeorefProposal(activeId, measureAR, { storageKey: activeGeorefKey, pairs: out.suggestion.pairs, previewUrl: georefPreviewUrl(), uncertain: !out.suggestion.confident })
    } catch (e) {
      if (runId !== autoRunRef.current) return // an orphaned failure has no audience either
      const unavailable = e instanceof ApiError && e.status === 503
      toast(unavailable ? appConfig.copy.whiteboard.georef.autoUnavailable : appConfig.copy.whiteboard.georef.autoFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      if (runId === autoRunRef.current) setAutoStep(null)
    }
  }
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
    linkChoice, setLinkChoice, autoStep, closeLinkChoice, canAutoAlign, runAutoAlign,
    qualityFor, setQualityFor, georefQuality, georefTransferOpen, setGeorefTransferOpen, georefTransferTargets, transferGeoref,
  }
}
