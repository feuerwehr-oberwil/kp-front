// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./api', () => ({ apiGet }))

import { BUNDLED_TEMPLATES, isTafelTemplateId, loadBoardTemplates } from './boardTemplates'

const station = { ...BUNDLED_TEMPLATES[0], id: 'oberwil', version: 3, title: 'FW Oberwil', pages: BUNDLED_TEMPLATES[0].pages.slice(0, 1) }

describe('the station’s board templates', () => {
  beforeEach(async () => { apiGet.mockReset(); localStorage.clear(); const { idbDel } = await import('./idb'); await idbDel?.('kp-front-board-templates') })

  it('a station set REPLACES the bundled FKS one — it never joins it', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference'
      ? [{ id: 'tafel:oberwil' }, { id: 'checklists:fu' }, { id: 'tafel:x:y' }]
      : station))
    const got = await loadBoardTemplates()
    expect(got.map((t) => t.id)).toEqual(['oberwil'])
    expect(apiGet).not.toHaveBeenCalledWith('/api/reference/tafel:x:y')
  })
  it('one template that does not arrive keeps the last COMPLETE set — never a shorter one', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [{ id: 'tafel:oberwil' }] : station))
    expect((await loadBoardTemplates()).map((t) => t.id)).toEqual(['oberwil'])
    const second = { ...station, id: 'zivilschutz' }
    apiGet.mockImplementation(async (p: string) => {
      if (p === '/api/reference') return [{ id: 'tafel:oberwil' }, { id: 'tafel:zivilschutz' }]
      if (p.endsWith('zivilschutz')) throw new TypeError('Failed to fetch')
      return station
    })
    expect((await loadBoardTemplates()).map((t) => t.id)).toEqual(['oberwil'])
    // …and a file this build cannot read counts as not arrived
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [{ id: 'tafel:oberwil' }, { id: 'tafel:zivilschutz' }]
      : p.endsWith('zivilschutz') ? { schema: 'board-template/2', id: 'zivilschutz' } : station))
    expect((await loadBoardTemplates()).map((t) => t.id)).toEqual(['oberwil'])
    void second
  })
  it('a station that removed its last template is back on the bundled FKS set', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [{ id: 'tafel:oberwil' }] : station))
    await loadBoardTemplates()
    apiGet.mockImplementation(async () => [])
    expect((await loadBoardTemplates()).map((t) => t.id)).toEqual(['fks-erste-fuehrung'])
  })
  it('offline, the last set it saw answers', async () => {
    apiGet.mockImplementation(async (p: string) => (p === '/api/reference' ? [{ id: 'tafel:oberwil' }] : station))
    await loadBoardTemplates()
    apiGet.mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await loadBoardTemplates()).map((t) => t.id)).toEqual(['oberwil'])
  })
  it('names the datasets it owns', () => {
    expect([isTafelTemplateId('tafel:fks-erste-fuehrung'), isTafelTemplateId('tafel:a:p1'), isTafelTemplateId('checklists:x')]).toEqual([true, false, false])
  })
})
