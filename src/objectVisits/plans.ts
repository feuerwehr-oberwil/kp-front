// The object's Modul-PDFs on a visit (owner, 05.10.2026: «quick access to the plans from the
// checklist, so nobody has to search for them elsewhere»). Read through `getObjectResilient`, so a
// visit opened offline still lists what the device saw last; the PDF itself comes from the service
// worker's reference cache when it was opened before, else from the network.

import { planLabel } from '../lib/navRail'
import { planDocId } from '../lib/karte/plans'
import { comparePlanModules } from '../lib/planOrder'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/incidents'

export interface VisitPlanRow {
  id: string
  version: number
  /** the plan's name, the row's and the reader's tab — «Modul 1», «Wasser», «PV», exactly what the
   *  object's sheet on the Karte says (owner, 27.10.2026; lib/navRail · planLabel). No subtitle:
   *  «Modul 1 · Übersicht» over «Situationsplan …» was a second name for the same sheet. */
  title: string
}

/** The object's PDF plans as rows, in the order every plan list uses (lib/planOrder). Pure. */
export function visitPlanRows(modules: readonly DeploymentModule[], plans: readonly ReferenceDataset[]): VisitPlanRow[] {
  const cmp = comparePlanModules(modules)
  return plans
    .filter((p) => p.module && (p.kind === 'pdf' || (p.content_type ?? '').includes('pdf')))
    .slice()
    .sort((a, b) => cmp(a.module ?? '', b.module ?? ''))
    .map((p) => ({ id: p.id, version: p.current_version, title: planLabel(planDocId({ id: p.id, module: p.module }), p.title ?? '') }))
}
