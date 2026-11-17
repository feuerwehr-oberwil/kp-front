// «Karte & Objekte» — the menu button («FWO ▾», review round 5 — it was «Einsätze ▾»): the app
// menu as a sheet hung off the bar (docs/karte-objekte.md · «Home»). App renders its rows; this
// only opens and closes it and gives the button its face.

import { useCallback, useRef, useState } from 'react'
import { useLayer } from '../../lib/overlays/layer'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { deploymentMenuMark, deploymentName } from '../../lib/deploymentConfig'

/** `barRef` is the top bar's: a press outside it (and outside any sheet or dialog opened FROM
 *  here) only closes the menu, as Escape and the native back do (lib/overlays/layer). The face is the station's mark and/or short name
 *  (lib/deploymentConfig · deploymentMenuMark); a mark that does not load (offline before it was
 *  ever fetched, `onMarkError`) steps back to the symbol, never a broken image. */
export function useKarteMenu() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const brand = deploymentMenuMark()
  const [markFailed, setMarkFailed] = useState(false)
  const mark = markFailed ? null : brand.mark
  const menuName = fillTemplate(appConfig.copy.karte.menuLabel, { name: deploymentName() })
  const barRef = useRef<HTMLDivElement>(null)
  const closeSheet = useCallback(() => setSheetOpen(false), [setSheetOpen])
  // the way out is every layer's (lib/overlays/layer): a tap beside it only closes it, Esc closes it
  // alone, the native back closes it – a press inside a sheet or dialog opened FROM here is not «outside»
  useLayer({ open: sheetOpen, onClose: closeSheet, inside: [barRef] })
  return { sheetOpen, setSheetOpen, closeSheet, barRef, short: brand.short, mark, onMarkError: () => setMarkFailed(true), menuName }
}
