import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readThrough } = vi.hoisted(() => ({ readThrough: vi.fn() }))
vi.mock('./idb', () => ({ readThrough }))
vi.mock('./api', () => ({ apiGet: vi.fn() }))

import { TEMPLATES_FRESH_MS, resetWarmTemplates, warmTemplates } from './checklists'

const list = (title: string) => ({ value: [{ id: title, kind: 'action', title }], source: 'network' })

// 20.09.2026: the Checkliste surface waited for the registry every time it was opened. The
// workspace warms the list when the Einsatz opens; the surface reads what is already there.
describe('warmTemplates', () => {
  beforeEach(() => { resetWarmTemplates(); readThrough.mockReset() })

  it('loads once, however many callers ask while the answer is fresh', async () => {
    readThrough.mockResolvedValue(list('a'))
    const first = warmTemplates(1_000)
    const second = warmTemplates(1_000 + TEMPLATES_FRESH_MS)
    expect(second.list).toBe(first.list)
    expect(second.newer).toBeNull()
    expect(readThrough).toHaveBeenCalledTimes(1)
    expect((await first.list)[0].title).toBe('a')
  })

  it('hands out the stale list at once and its reload behind it', async () => {
    readThrough.mockResolvedValueOnce(list('old')).mockResolvedValueOnce(list('new'))
    const first = warmTemplates(1_000)
    const later = warmTemplates(1_001 + TEMPLATES_FRESH_MS)
    expect(later.list).toBe(first.list)
    expect((await later.newer!)[0].title).toBe('new')
    // …and the reload is what the next caller gets, without a third request
    expect(warmTemplates(1_002 + TEMPLATES_FRESH_MS).list).toBe(later.newer)
    expect(readThrough).toHaveBeenCalledTimes(2)
  })
})
