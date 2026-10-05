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
  /** the sheet's full name, the way the row and the reader's head print it — «Modul 1 · Übersicht»,
   *  «M5 · Wasser». Never the bare letter code: «W» alone meant nothing on the visit (owner,
   *  05.10.2026: «show the full name of plans (not just "w")»). */
  title: string
  /** the reader's tab — the station's «Modul N» where it has one, else the word: «Modul 1», «Wasser» */
  short: string
  /** what the sheet holds — the catalogue's subtitle («Löschwasser / Wasserversorgung»), may be '' */
  sub: string
}

/** A code that is a NUMBERED module («Modul 1», «M5», «Modul 2/3») rather than a letter for a word («W», «PV»). */
const numbered = (code: string) => /\d/.test(code)

/** «Modul 5» for an id without any catalogue entry */
const bareModule = (id: string) => `Modul ${/^modul(\d+)/i.exec(id)?.[1] ?? '?'}`

/** The object's PDF plans as rows, in the order every plan list uses (lib/planOrder). Pure. */
export function visitPlanRows(modules: readonly DeploymentModule[], plans: readonly ReferenceDataset[]): VisitPlanRow[] {
  const cmp = comparePlanModules(modules)
  return plans
    .filter((p) => p.module && (p.kind === 'pdf' || (p.content_type ?? '').includes('pdf')))
    .slice()
    .sort((a, b) => cmp(a.module ?? '', b.module ?? ''))
    .map((p) => {
      const id = p.module as string
      // a sub-slot (`modul5-wasser`) belongs to its family's number (`modul5` · «M5»)
      const family = modules.find((m) => m.family && id.startsWith(`${m.id}-`))
      const exact = modules.find((m) => m.id === id)
      const code = (exact?.code ?? '').trim()
      // the word: the catalogue's title, else the sub-slot's own name, else the code
      const word = (exact?.title ?? '').trim() || (exact ? '' : moduleTileLabel(id, p.title ?? undefined)) || code || moduleTileLabel(id)
      // the number in front: the module's own numbered code, else its family's, else none
      const number = code && numbered(code) ? code : (family?.code ?? (exact ? '' : bareModule(id))).trim()
      const title = number && number !== word ? `${number} · ${word}` : word
      return {
        id: p.id,
        version: p.current_version,
        title,
        short: code && numbered(code) ? code : word,
        sub: (exact?.subtitle ?? '').trim(),
      }
    })
}
