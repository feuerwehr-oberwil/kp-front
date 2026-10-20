import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), apiGet }))

import { __resetIdbForTests } from './idb'
import {
  checklistImageUrls,
  isTickable,
  loadTemplates,
  manualGroups,
  resetWarmManualImages,
  warmManualImages,
  type ChecklistTemplate,
} from './checklists'

// Anleitungen (kind: manual, 05.10.2026): read-only device instructions, grouped by device in the
// Checkliste picker, their step pictures prefetched for offline.

const manual = (id: string, device: string, extra: Partial<ChecklistTemplate> = {}): ChecklistTemplate => ({
  id, kind: 'manual', title: id, device, version: 1, source: 'Demo', steps: [{ text: 'a' }], ...extra,
})

const TEMPLATES: ChecklistTemplate[] = [
  { id: 'fu', kind: 'action', title: 'Aufgaben FU', version: 1, source: 'x', phases: [] },
  manual('Stromerzeuger starten', 'Stromerzeuger 8 kVA', {
    keywords: ['Generator'],
    steps: [{ text: 'a', images: [{ page: 1 }, { page: 2 }] }, { text: 'b', images: [{ page: 1 }] }],
  }),
  manual('Hebekissen abbauen', 'Hebekissen'),
  manual('Hebekissen einsetzen', 'Hebekissen'),
  {
    id: 'taktik', kind: 'reference', title: 'Taktik', version: 1, source: 'x',
    entries: [{ id: 'e', title: 'E', keywords: [], content: [{ type: 'image', page: 12 }, { type: 'note', text: 'n' }] }],
  },
]

describe('manualGroups', () => {
  // template (= manifest) order for devices too since 19.10.2026 – it was by name
  it('groups by device, devices and their manuals in template order', () => {
    expect(manualGroups(TEMPLATES, '').map((g) => [g.device, g.manuals.map((t) => t.id)])).toEqual([
      ['Stromerzeuger 8 kVA', ['Stromerzeuger starten']],
      ['Hebekissen', ['Hebekissen abbauen', 'Hebekissen einsetzen']],
    ])
  })

  it('finds a manual by its device and by a keyword, not only by its title', () => {
    expect(manualGroups(TEMPLATES, 'kva').map((g) => g.device)).toEqual(['Stromerzeuger 8 kVA'])
    expect(manualGroups(TEMPLATES, 'generator').map((g) => g.device)).toEqual(['Stromerzeuger 8 kVA'])
    expect(manualGroups(TEMPLATES, 'einsetzen')[0].manuals.map((t) => t.id)).toEqual(['Hebekissen einsetzen'])
    expect(manualGroups(TEMPLATES, 'Aufgaben')).toEqual([])
  })

  it('a manual without a device groups under its own title rather than vanishing', () => {
    expect(manualGroups([manual('Solo', '')], '')).toEqual([{ device: 'Solo', manuals: [expect.objectContaining({ id: 'Solo' })] }])
  })
})

describe('isTickable', () => {
  it('ticks action and rapport lists only — never a manual or a reference', () => {
    expect(TEMPLATES.filter(isTickable).map((t) => t.id)).toEqual(['fu'])
  })
})

describe('checklistImageUrls', () => {
  it('lists every step picture and playbook diagram once', () => {
    expect(checklistImageUrls(TEMPLATES)).toEqual([
      '/api/reference/checklists:Stromerzeuger starten:p1',
      '/api/reference/checklists:Stromerzeuger starten:p2',
      '/api/reference/checklists:taktik:p12',
    ])
  })

  it('lists a cover too – a photo no step shows is still needed offline', () => {
    expect(checklistImageUrls([manual('m', 'D', { cover: 7 })])).toEqual(['/api/reference/checklists:m:p7'])
  })
})

describe('loadTemplates', () => {
  it('stamps each template with its asset pages\' versions from the registry list', async () => {
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/api/reference') {
        return [{ id: 'checklists:m', current_version: 1 }, { id: 'checklists:m:p1', current_version: 4 }, { id: 'checklists:m:p2', current_version: 1 }]
      }
      return manual('m', 'D', { steps: [{ text: 'a', images: [{ page: 1 }, { page: 2 }] }] })
    })
    const [m] = await loadTemplates()
    expect(checklistImageUrls([m])).toEqual(['/api/reference/checklists:m:p1?v=4', '/api/reference/checklists:m:p2?v=1'])
  })
})

describe('warmManualImages', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetWarmManualImages() })

  const stub = (opts: { controller: boolean; onLine?: boolean; cached?: string[] }) => {
    const fetchMock = vi.fn(async () => new Response('img'))
    vi.stubGlobal('navigator', { onLine: opts.onLine ?? true, serviceWorker: { controller: opts.controller ? {} : null } })
    vi.stubGlobal('caches', { match: vi.fn(async (u: string) => ((opts.cached ?? []).includes(u) ? new Response('x') : undefined)) })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('fetches each uncached picture once, through the service worker', async () => {
    const f = stub({ controller: true, cached: ['/api/reference/checklists:taktik:p12'] })
    await warmManualImages(TEMPLATES)
    await warmManualImages(TEMPLATES) // a second warm in the same session asks for nothing
    expect(f.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      '/api/reference/checklists:Stromerzeuger starten:p1',
      '/api/reference/checklists:Stromerzeuger starten:p2',
    ])
  })

  it('does nothing without a controlling service worker or offline', async () => {
    const f = stub({ controller: false })
    await warmManualImages(TEMPLATES)
    expect(f).not.toHaveBeenCalled()
    const g = stub({ controller: true, onLine: false })
    await warmManualImages(TEMPLATES)
    expect(g).not.toHaveBeenCalled()
  })
})
