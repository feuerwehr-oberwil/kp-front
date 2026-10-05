import { beforeEach, describe, expect, it, vi } from 'vitest'

const listPersonnel = vi.fn()
vi.mock('./incidents', () => ({ listPersonnel: (...a: unknown[]) => listPersonnel(...a) }))
const store = new Map<string, unknown>()
vi.mock('./idb', () => ({
  idbGet: (k: string) => Promise.resolve(store.get(k)),
  idbSet: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve() },
}))

import { loadRoster } from './usePersonnel'
import type { Person } from '../types'

const person = (id: string): Person => ({ id, displayName: id, active: true, updatedAt: 't0' })

beforeEach(() => { listPersonnel.mockReset(); store.clear() })

// 05.10.2026, owner's Übung in airplane mode: the Leeres Erfassungsblatt printed an empty
// «Personal / Anwesenheit» because it asked the server and nothing else.
describe('loadRoster — the roster for a one-off read, offline too', () => {
  it('takes the server list and keeps it for later', async () => {
    listPersonnel.mockResolvedValue([person('a'), person('b')])
    expect((await loadRoster()).map((p) => p.id)).toEqual(['a', 'b'])
    // …so the next offline read has it
    listPersonnel.mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await loadRoster()).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('falls back to the last roster the device held when the server cannot be reached', async () => {
    store.set('kp-front-roster', [person('c')])
    listPersonnel.mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await loadRoster()).map((p) => p.id)).toEqual(['c'])
  })

  it('rejects only when there is neither an answer nor a cache', async () => {
    listPersonnel.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(loadRoster()).rejects.toThrow('Failed to fetch')
  })
})
