// What every screen of the Objektbesuche surface shares (provided by ObjectVisitsApp).

import { createContext, useContext } from 'react'
import type { CatalogueState } from '../../objectVisits/catalogue'
import type { OvRoute } from '../../objectVisits/route'
import type { LocalVisit } from '../../objectVisits/store'
import type { VisitSummary } from '../../objectVisits/types'

export interface OvShared {
  cat: CatalogueState | null
  reloadCatalogue: () => void
  locals: LocalVisit[]
  /** the device list has been read at least once (until then «no draft» is not known) */
  localsLoaded: boolean
  /** false = the device index could not be read (the list is not the whole truth) */
  localsOk: boolean
  summaries: VisitSummary[] | null
  userId: string | null
  canCapture: boolean
  sessionExpired: boolean
  relogin: () => void
  go: (r: OvRoute, opts?: { replace?: boolean }) => void
  /** the object of the Einsatz the surface was opened from (its plans are on the board) — offered
   *  first on the Übersicht; null when opened from the launcher */
  suggestedObjectId: string | null
  exit: () => void
}

export const OvContext = createContext<OvShared | null>(null)

export function useOv(): OvShared {
  const v = useContext(OvContext)
  if (!v) throw new Error('useOv outside ObjectVisitsApp')
  return v
}
