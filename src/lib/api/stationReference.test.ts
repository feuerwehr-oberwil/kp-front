import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// «Unterirdische Bauten» on the device (review round 4): the region's set is kept like the
// catalogue, asked with the set the device holds, and never shown to a session that was refused.

const { apiGet, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), ApiError }
})
vi.mock('../api', () => ({
  apiGet,
  ApiError,
  isUnverifiable: (e: unknown) => e instanceof ApiError && [0, 502, 503, 504].includes(e.status),
  isDenial: (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status),
}))

import { __resetIdbForTests, idbRead } from '../idb'
import { loadUnderground, undergroundRings, type UndergroundSet } from './stationReference'

const sq = (lng: number, lat: number) => [[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]
const SET: UndergroundSet = { fetchedAt: '2026-10-17T03:00:00+00:00', count: 2, geometry: { type: 'MultiPolygon', coordinates: [[sq(7.5, 47.5)], [sq(7.6, 47.6)]] } }
const answer = (over: Record<string, unknown> = {}) => ({ enabled: true, ...SET, ...over })
const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  apiGet.mockReset()
})

describe('loadUnderground', () => {
  it('keeps the set on the device and asks with it next time', async () => {
    apiGet.mockResolvedValueOnce(answer())
    expect((await loadUnderground())?.count).toBe(2)
    expect(apiGet).toHaveBeenLastCalledWith('/api/reference/underground')
    await flush()
    apiGet.mockResolvedValueOnce({ enabled: true, fetchedAt: SET.fetchedAt, count: 2, unchanged: true })
    expect(await loadUnderground()).toEqual(SET)
    expect(apiGet).toHaveBeenLastCalledWith(`/api/reference/underground?have=${encodeURIComponent(SET.fetchedAt)}`)
  })

  it('offline: the device copy; never loaded: nothing', async () => {
    apiGet.mockRejectedValueOnce(new ApiError(0, 'offline'))
    expect(await loadUnderground()).toBeNull()
    apiGet.mockResolvedValueOnce(answer())
    await loadUnderground()
    await flush()
    apiGet.mockRejectedValueOnce(new ApiError(503, 'down'))
    expect(await loadUnderground()).toEqual(SET)
  })

  it('a refusal throws instead of showing the copy, and «switched off» forgets it', async () => {
    apiGet.mockResolvedValueOnce(answer())
    await loadUnderground()
    await flush()
    apiGet.mockRejectedValueOnce(new ApiError(403, 'link'))
    await expect(loadUnderground()).rejects.toBeInstanceOf(ApiError)
    apiGet.mockResolvedValueOnce({ enabled: false })
    expect(await loadUnderground()).toBeNull()
    await flush()
    const left = await idbRead('kp-front-station-underground')
    expect(left.ok && left.value != null).toBe(false)
  })

  it('not asked by the server yet: nothing to draw', async () => {
    apiGet.mockResolvedValueOnce({ enabled: true, fetchedAt: null, count: 0 })
    expect(await loadUnderground()).toBeNull()
  })
})

describe('undergroundRings', () => {
  it('hands the map open rings, one per building', () => {
    const rings = undergroundRings(SET)
    expect(rings).toHaveLength(2)
    expect(rings[0]).toEqual([[7.5, 47.5], [7.501, 47.5], [7.501, 47.501], [7.5, 47.501]])
    expect(undergroundRings(null)).toEqual([])
  })
})
