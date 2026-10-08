import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checklistImageUrls,
  isTickable,
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
  it('groups by device, devices by name, manuals in template order', () => {
    expect(manualGroups(TEMPLATES, '').map((g) => [g.device, g.manuals.map((t) => t.id)])).toEqual([
      ['Hebekissen', ['Hebekissen abbauen', 'Hebekissen einsetzen']],
      ['Stromerzeuger 8 kVA', ['Stromerzeuger starten']],
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
