import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), apiGet }))

import { __resetIdbForTests } from './idb'
import { loadTemplates } from './checklists'

// docs/object-visits.md: an Objektbesuch checklist shares the distribution (`checklists:<id>`),
// never the surface — every incident surface reads loadTemplates, so it must leave them out.
describe('loadTemplates and kind «visit»', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
    apiGet.mockReset()
  })

  it('never hands an incident surface a visit checklist', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/reference') return [{ id: 'checklists:fu' }, { id: 'checklists:schluessel' }]
      if (path === '/api/reference/checklists:fu') return { id: 'fu', kind: 'action', title: 'FU', version: 1, source: 's', phases: [] }
      return { id: 'schluessel', kind: 'visit', title: 'Schlüsselhülse', version: 1, source: 's', phases: [] }
    })
    const list = await loadTemplates()
    expect(list.map((t) => t.id)).toEqual(['fu'])
  })

  it('a station with only visit checklists gets the neutral fallback, not an empty rail', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/reference') return [{ id: 'checklists:schluessel' }]
      return { id: 'schluessel', kind: 'visit', title: 'Schlüsselhülse', version: 1, source: 's', phases: [] }
    })
    const list = await loadTemplates()
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((t) => t.kind === 'visit')).toBe(false)
  })
})
