// «Karte & Objekte» — the way back (docs/karte-objekte.md · «The viewer», «Home»): the address
// follows the selection, the view is kept for this session (lib/karte/session), and the surface
// says where it picked up.

import { useEffect, useRef } from 'react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { toast } from '../../lib/ui'
import { consumeJustUpdated } from '../../lib/swUpdate'
import { buildLabel } from '../../lib/buildInfo'
import type { viewerPlanDocs } from '../../lib/karte/plans'
import { karteHref } from '../../lib/karte/route'
import { saveKarteView, type KarteTool } from '../../lib/karte/session'
import type { StationObject } from '../../lib/api/stationReference'
import { navigateTo } from '../../objectVisits/route'
import type { LngLat } from '../../types'
import type { Tool } from './useKarteTools'

/** /karte?objekt=<id> follows the selection (deep-linkable, no history entry) — once the
 *  catalogue has answered (`ready`): until then the deep link is still being resolved. */
export function useKarteAddress(objectId: string | null, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const want = karteHref({ objekt: objectId })
    if (`${window.location.pathname}${window.location.search}` !== want && window.location.pathname.startsWith('/karte')) navigateTo(want, { replace: true })
  }, [objectId, ready])
}

/** The view kept for the way back (an Objektbesuch, an Einsatz, a reload) — with the words the
 *  Einsatz menu's row says it returns to («Zurück zu Schloss Musterdorf · Modul 1»).
 *  ⚠️ Not before the catalogue has answered (or failed, `ready`): until then nothing is selected
 *  yet, and leaving that early would overwrite the object the session was on with «nothing». */
export function useKeepKarteView(p: {
  ready: boolean
  view: { center: LngLat; zoom: number; bearing: number }
  selObj: StationObject | null
  openDoc: ReturnType<typeof viewerPlanDocs>[number] | null
  onLibrary: boolean
  tool: Tool
}) {
  const C = appConfig.copy.karte
  const { ready, view, selObj, openDoc, onLibrary, tool } = p
  const objectId = selObj?.id ?? null
  // the open tool comes back too (only WHICH one); never the pin mode
  const keptTool: KarteTool | null = tool === 'measure' || tool === 'erg' || tool === 'layers' ? tool : null
  const viewLabel = onLibrary ? appConfig.copy.modes.checklists
    : selObj
    ? [selObj.name, openDoc && (openDoc.plan ? fillTemplate(C.backPlan, { code: openDoc.doc.code }) : openDoc.doc.title)].filter(Boolean).join(' · ')
    : null
  useEffect(() => {
    if (!ready) return
    const surf = onLibrary ? 'checkliste' as const : !openDoc ? 'karte' as const : openDoc.plan ? { plan: openDoc.plan.id } : 'gebaeude' as const
    saveKarteView({ ...view, objectId, surface: surf, tool: keptTool, label: viewLabel })
  }, [ready, view, objectId, openDoc, onLibrary, keptTool, viewLabel])
}

/** Back from an Einsatz (`announce`): one line that says where it picked up (mockup j8-5, the
 *  kept view's `label`), once per entry — and the one-shot «Aktualisiert – v…» after an update
 *  reload, the Einsatz's toast (IncidentWorkspace): the Karte is home now, so an update that lands
 *  with no Einsatz open reloads into HERE (review round 7). consumeJustUpdated is one-shot
 *  app-wide, so a covered Einsatz behind the Karte can never say it a second time. */
export function useReturnToasts(announce: boolean, label: string | null | undefined) {
  const C = appConfig.copy.karte
  const announced = useRef(false)
  useEffect(() => {
    // once per mount (a ref, so StrictMode's second run says nothing): the entry is what is announced
    if (announced.current) return
    announced.current = true
    if (announce && label) toast(fillTemplate(C.backAt, { where: label }), { icon: 'check' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (consumeJustUpdated()) toast(fillTemplate(appConfig.copy.update.updated, { v: buildLabel() }), { icon: 'check', tone: 'success' })
  }, [])
}
