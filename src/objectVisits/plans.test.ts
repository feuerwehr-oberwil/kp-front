import { describe, expect, it } from 'vitest'
import { visitPlanRows } from './plans'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/api/reference'

const modules: DeploymentModule[] = [
  { id: 'modul1', code: 'Modul 1', title: 'Übersicht', subtitle: 'Situationsplan mit Zufahrt', order: 1 },
  { id: 'modul2', code: 'Modul 2', title: 'Wie komme ich herein', order: 2 },
  { id: 'modul2-3', code: 'Modul 2/3', title: 'Zugang & Objekt', order: 4 },
  { id: 'modul5', code: 'M5', title: 'Spezialpläne', order: 5, family: true },
  { id: 'modul5-wasser', code: 'W', title: 'Wasser', subtitle: 'Löschwasser', order: 5 },
]
const plan = (module: string | null, over: Partial<ReferenceDataset> = {}): ReferenceDataset => ({
  id: `plan:o:${module}`, object_id: 'o', module, kind: 'pdf', title: null, source_type: 'uploaded', source_note: null,
  content_type: 'application/pdf', size_bytes: 1, feature_count: null, current_version: 3, fetch_url: null, updated_at: '', ...over,
})

describe('visitPlanRows — the object\'s plans on a visit', () => {
  // owner, 27.10.2026: «Modul 1» exactly like on the object — no «· Übersicht», no subtitle
  it('lists the PDFs in module order by the plan\'s name alone', () => {
    const rows = visitPlanRows(modules, [plan('modul5-pv'), plan('modul2-3'), plan('modul1'), plan('modul5-wasser')])
    expect(rows.map((r) => r.title)).toEqual(['Modul 1', 'Modul 2/3', 'PV', 'Wasser'])
  })

  // owner, 05.10.2026 («not just "w"») and 27.10.2026 («Wasser 1, Wasser 2»)
  it('never shows a letter code — the catalogue\'s «W» is «Wasser», a sibling keeps its number', () => {
    expect(visitPlanRows(modules, [plan('modul5-wasser'), plan('modul5-wasser2')]).map((r) => r.title)).toEqual(['Wasser', 'Wasser 2'])
  })

  it('a module the catalogue does not know still gets a name', () => {
    expect(visitPlanRows(modules, [plan('modul7')])[0]).toMatchObject({ title: 'Modul 7' })
  })

  it('carries the version, so a replaced sheet is never served from an old cache', () => {
    expect(visitPlanRows(modules, [plan('modul1', { current_version: 7 })])[0]).toMatchObject({ id: 'plan:o:modul1', version: 7 })
  })

  it('leaves out what is not a module PDF', () => {
    expect(visitPlanRows(modules, [plan(null), plan('modul1', { kind: 'geojson', content_type: 'application/geo+json' })])).toEqual([])
  })
})
