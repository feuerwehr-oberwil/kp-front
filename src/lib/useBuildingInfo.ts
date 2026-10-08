import { useEffect, useState } from 'react'
import { buildingResilient, type BuildingInfo } from './api/building'
import { getLocaleId } from '../config/copy'
import { useOnline } from './useOnline'

/**
 * The Gebäude card's data for the open Einsatz (lib/api/building): fetched when the Einsatz
 * opens — not when the menu does, so it is cached for offline before anybody needs it — again
 * when the effective Einsatzobjekt changes (a manual pick on the Plan surface), and again when the
 * device comes back online. `enabled` false (a Rapport view link, which may not ask) → null.
 */
export function useBuildingInfo(incidentId: string | null | undefined, objectId: string | null | undefined, enabled = true): BuildingInfo | null {
  // keyed by the Einsatz it belongs to, so switching Einsätze never shows the last one's building
  const [got, setGot] = useState<{ incidentId: string; info: BuildingInfo | null } | null>(null)
  const online = useOnline()
  useEffect(() => {
    if (!incidentId || !enabled) return
    let alive = true
    const lang = getLocaleId().slice(0, 2).toLowerCase()
    void buildingResilient(incidentId, objectId, lang).then((info) => { if (alive) setGot({ incidentId, info }) }).catch(() => {})
    return () => { alive = false }
  }, [incidentId, objectId, enabled, online])
  return enabled && got && got.incidentId === incidentId ? got.info : null
}
