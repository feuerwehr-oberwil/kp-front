import { describe, expect, it } from 'vitest'
import { visitPlanRows } from './plans'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/api/reference'

const modules: DeploymentModule[] = [
  { id: 'modul1', code: 'Modul 1', title: 'Übersicht', order: 1 },
  { id: 'modul2', code: 'Modul 2', title: 'Wie komme ich herein', order: 2 },
  { id: 'modul2-3', code: 'Modul 2/3', title: 'Zugang & Objekt', order: 4 },
  { id: 'modul5', code: 'M5', title: 'Spezialpläne', order: 5, family: true },
]
const plan = (module: string | null, over: Partial<ReferenceDataset> = {}): ReferenceDataset => ({
  id: `plan:o:${module}`, object_id: 'o', module, kind: 'pdf', title: null, source_type: 'uploaded', source_note: null,
  content_type: 'application/pdf', size_bytes: 1, feature_count: null, current_version: 3, updated_at: '', ...over,
})

describe('visitPlanRows — the object\'s plans on a visit', () => {
  it('lists the PDFs in module order with the station\'s code and title', () => {
    const rows = visitPlanRows(modules, [plan('modul5-pv'), plan('modul2-3'), plan('modul1')])
    expect(rows.map((r) => [r.title, r.sub])).toEqual([['Modul 1', 'Übersicht'], ['Modul 2/3', 'Zugang & Objekt'], ['M5', 'PV']])
  })

  it('carries the version, so a replaced sheet is never served from an old cache', () => {
    expect(visitPlanRows(modules, [plan('modul1', { current_version: 7 })])[0]).toMatchObject({ id: 'plan:o:modul1', version: 7 })
  })

  it('leaves out what is not a module PDF', () => {
    expect(visitPlanRows(modules, [plan(null), plan('modul1', { kind: 'geojson', content_type: 'application/geo+json' })])).toEqual([])
  })
})
