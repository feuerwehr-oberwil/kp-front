import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Gebäude card's device half (KP Front F5): cached per Einsatz for offline, and merged per
// SOURCE so one register failing never wipes what the last good answer said.

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
}))

import { __resetIdbForTests } from '../idb'
import { buildingResilient, buildingWhere, getBuilding, mergeBuilding, type BuildingInfo } from './building'

const info = (over: Partial<BuildingInfo> = {}): BuildingInfo => ({
  registers: 'on',
  egid: '408319',
  address: 'Hauptstrasse 10, 4104 Oberwil',
  gwr: {
    stand: '2026-10-07', floors: 2, flats: 2, year: 1926, period: null, heating: ['gas'],
    heating_date: '2022-06-29', hot_water: ['gas'], shelter: null, status: null,
  },
  gwr_status: 'ok',
  plants: [{ kind: 'pv', label: 'Photovoltaik', power_kw: 35.64, since: '2024-09-30' }],
  pv_status: 'ok',
  registers_fetched_at: '2026-10-08T10:00:00+02:00',
  object: null,
  visit: null,
  ...over,
})

const HERE = buildingWhere('Hauptstrasse 10, 4104 Oberwil', 47.515297, 7.557682)
const THERE = buildingWhere('Hauptstrasse 12, 4104 Oberwil', 47.5154, 7.5578)
const card = (incidentId: string, where = HERE) => buildingResilient(incidentId, null, 'de', where)

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  apiGet.mockReset()
})

describe('mergeBuilding', () => {
  const down = (where: string) => info({ egid: null, address: null, gwr: null, gwr_status: 'error', plants: [], pv_status: 'skipped', registers_fetched_at: '2026-10-09T10:00:00+02:00', where })

  it('a GWR outage keeps the last good building of the SAME place, PV included', () => {
    const out = mergeBuilding(down(HERE), info({ where: HERE }))
    expect(out.gwr?.heating).toEqual(['gas'])
    expect(out.gwr_status).toBe('ok')
    expect(out.plants).toHaveLength(1)
    expect(out.gwr_kept_from).toBe('2026-10-08T10:00:00+02:00')
  })

  it('a GWR outage after the address was corrected keeps NOTHING of the old building', () => {
    const out = mergeBuilding(down(THERE), info({ where: HERE }))
    expect(out.gwr).toBeNull()
    expect(out.gwr_status).toBe('error')
    expect(out.plants).toEqual([])
    // and an answer that never said where it was asked is no proof of «same place» either
    expect(mergeBuilding(down(HERE), info()).gwr).toBeNull()
  })

  it('a PV outage keeps the last plants of the SAME building only', () => {
    const fresh = info({ plants: [], pv_status: 'error' })
    expect(mergeBuilding(fresh, info()).plants).toHaveLength(1)
    // the address was corrected: another building — its roof is not ours
    const elsewhere = info({ egid: '1', plants: [], pv_status: 'error' })
    expect(mergeBuilding(elsewhere, info()).plants).toEqual([])
  })

  it('a clean answer wins, and nothing is kept when the registers are off', () => {
    const fresh = info({ gwr: { ...info().gwr!, floors: 3 } })
    expect(mergeBuilding(fresh, info()).gwr?.floors).toBe(3)
    const off = info({ registers: 'off', gwr: null, gwr_status: 'skipped', plants: [], pv_status: 'skipped' })
    expect(mergeBuilding(off, info()).gwr).toBeNull()
  })
})

describe('buildingResilient', () => {
  it('asks for the Einsatz, the picked object and the language', async () => {
    apiGet.mockResolvedValue(info())
    await getBuilding('inc-1', 'obj-1', 'fr')
    expect(apiGet).toHaveBeenCalledWith('/api/incidents/inc-1/building?lang=fr&object=obj-1')
  })

  it('offline → the last copy of THIS Einsatz at THIS place; never one → nothing', async () => {
    apiGet.mockResolvedValueOnce(info())
    expect((await card('inc-1'))?.egid).toBe('408319')
    await new Promise((r) => setTimeout(r, 10)) // the cache write is fire-and-forget
    apiGet.mockRejectedValue(new ApiError(0, 'offline'))
    expect((await card('inc-1'))?.gwr?.floors).toBe(2)
    expect(await card('inc-2')).toBeNull()
    // the address was corrected while offline: the old building's card is not this one's
    expect(await card('inc-1', THERE)).toBeNull()
  })

  it('a refusal is not silence: no cached card, no throw', async () => {
    apiGet.mockResolvedValueOnce(info())
    await card('inc-1')
    await new Promise((r) => setTimeout(r, 10))
    apiGet.mockRejectedValue(new ApiError(403, 'nein'))
    expect(await card('inc-1')).toBeNull()
  })

  it('merges a failed source with the cached one on the way in', async () => {
    apiGet.mockResolvedValueOnce(info())
    await card('inc-1')
    await new Promise((r) => setTimeout(r, 10))
    apiGet.mockResolvedValueOnce(info({ plants: [], pv_status: 'error' }))
    expect((await card('inc-1'))?.plants).toHaveLength(1)
  })
})
