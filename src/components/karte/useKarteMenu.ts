// «Karte & Objekte» — the menu button («FWO ▾», review round 5 — it was «Einsätze ▾»): the app
// menu as a sheet hung off the bar (docs/karte-objekte.md · «Home»). App renders its rows; this
// only opens and closes it and gives the button its face.

import { useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { deploymentMenuMark, deploymentName } from '../../lib/deploymentConfig'

/** `barRef` is the top bar's: a press outside it (and outside any sheet or dialog opened FROM
 *  here) closes the menu, as Escape does. The face is the station's mark and/or short name
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
  useEffect(() => {
    if (!sheetOpen) return
    // 'pointerdown' (touch fires the compat mousedown late or never) — the IncidentSwitcher's
    // rule: a press inside a sheet or dialog opened FROM here is not «outside»
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Element
      if (barRef.current && !barRef.current.contains(t) && !t.closest?.('.ip-sheet, .ui-backdrop, .help-scrim, .confirm-backdrop, .toaster')) setSheetOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false) }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [sheetOpen])
  return { sheetOpen, setSheetOpen, closeSheet, barRef, short: brand.short, mark, onMarkError: () => setMarkFailed(true), menuName }
}
