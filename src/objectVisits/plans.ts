// The object's Modul-PDFs on a visit (owner, 05.10.2026: «quick access to the plans from the
// checklist, so nobody has to search for them elsewhere»). Read through `getObjectResilient`, so a
// visit opened offline still lists what the device saw last; the PDF itself comes from the service
// worker's reference cache when it was opened before, else from the network.

import { moduleTileLabel } from '../lib/navRail'
import { comparePlanModules } from '../lib/planOrder'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/api/reference'

export interface VisitPlanRow {
  id: string
  version: number
  /** «Modul 1», «M5» — the station's own code, the way it is printed on the sheet */
  title: string
  /** «Übersicht», «PV» — what the sheet is */
  sub: string
}

/** The object's PDF plans as rows, in the order every plan list uses (lib/planOrder). Pure. */
export function visitPlanRows(modules: readonly DeploymentModule[], plans: readonly ReferenceDataset[]): VisitPlanRow[] {
  const cmp = comparePlanModules(modules)
  return plans
    .filter((p) => p.module && (p.kind === 'pdf' || (p.content_type ?? '').includes('pdf')))
    .slice()
    .sort((a, b) => cmp(a.module ?? '', b.module ?? ''))
    .map((p) => {
      const id = p.module as string
      const exact = modules.find((m) => m.id === id)
      if (exact) return { id: p.id, version: p.current_version, title: exact.code ?? moduleTileLabel(id), sub: exact.title ?? '' }
      const family = modules.find((m) => m.family && id.startsWith(`${m.id}-`))
      return {
        id: p.id,
        version: p.current_version,
        title: family?.code ?? `Modul ${/^modul(\d+)/i.exec(id)?.[1] ?? '?'}`,
        sub: moduleTileLabel(id, p.title ?? undefined),
      }
    })
}
