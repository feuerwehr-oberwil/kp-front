import { useEffect, useState } from 'react'
import { buildingResilient, buildingWhere, type BuildingInfo } from './api/building'
import { getLocaleId } from '../config/copy'
import { useOnline } from './useOnline'

/**
 * The Gebäude card's data for the open Einsatz (lib/api/building): fetched when the Einsatz
 * opens — not when the menu does, so it is cached for offline before anybody needs it — again
 * when the effective Einsatzobjekt changes (a manual pick on the Plan surface), when the Einsatzort
 * changes (an address corrected in «Bearbeiten» moves the building), and when the device comes back
 * online. `enabled` false (a Rapport view link, which may not ask) → null.
 */
export function useBuildingInfo(
  incident: { id: string; address: string | null; lat: number | null; lng: number | null } | null | undefined,
  objectId: string | null | undefined,
  enabled = true,
): BuildingInfo | null {
  const incidentId = incident?.id
  const where = buildingWhere(incident?.address, incident?.lat, incident?.lng)
  // keyed by the Einsatz AND the place it was asked for, so neither switching Einsätze nor
  // correcting the address ever shows the previous building, not even for a frame
  const [got, setGot] = useState<{ incidentId: string; where: string; info: BuildingInfo | null } | null>(null)
  const online = useOnline()
  useEffect(() => {
    if (!incidentId || !enabled) return
    let alive = true
    const lang = getLocaleId().slice(0, 2).toLowerCase()
    void buildingResilient(incidentId, objectId, lang, where).then((info) => { if (alive) setGot({ incidentId, where, info }) }).catch(() => {})
    return () => { alive = false }
  }, [incidentId, where, objectId, enabled, online])
  return enabled && got && got.incidentId === incidentId && got.where === where ? got.info : null
}
