import { describe, it, expect } from 'vitest'
import type { StationObject, StationPlan } from '../api/stationReference'
import { noteBuildingAsked } from '../api/stationReference'
import { karteCopy } from '../../config/copy/de/karte'
import {
  MAX_VIEW_TILES, PARENT_DEPTH, STORAGE_LOW_BYTES, deviceRows, missingTiles, objectAvailability, planKey,
  rasterTileZoom, shareLamp, tileRing, tileUrls, viewTiles, type DeviceFacts, type PlanHeld, type TileXY,
} from './availability'

// Synthetic station data only (the mockup's Musterdorf).
const plan = (code: string, o: Partial<StationPlan> = {}): StationPlan => ({
  id: `plan:schloss:modul${code}`, module: `modul${code}`, code, title: `Modul ${code}`, pages: null, georef: false, version: 1, ...o,
})
const M1 = plan('1')
const M23 = plan('23', { georef: true, version: 2 })
const M6 = plan('6')
const OBJ: Pick<StationObject, 'plans' | 'floors'> = { plans: [M1, M23, M6], floors: [{ index: 0, name: null }, { index: 1, name: null }] }
const held = (m: Record<string, PlanHeld>) => m

describe('objectAvailability — what opens without a network', () => {
  it('a plan is held only when its PDF is in the cache; an unasked plan is not held', () => {
    const a = objectAvailability(OBJ, held({ [planKey(M1)]: { pdf: true, meta: null }, [planKey(M6)]: { pdf: false, meta: null } }))
    expect(a.plans).toEqual({ [planKey(M1)]: true, [planKey(M23)]: false, [planKey(M6)]: false })
  })

  it('the plan key carries the revision: an older revision in the cache is not this one', () => {
    expect(planKey(M23)).toBe('plan:schloss:modul23@2')
    const a = objectAvailability(OBJ, held({ 'plan:schloss:modul23@1': { pdf: true, meta: { floors: 0 } } }))
    expect(a.plans[planKey(M23)]).toBe(false)
  })

  it('Gebäude is on the device only when every revision\'s metadata AND every storey PDF is', () => {
    const all = held({
      [planKey(M1)]: { pdf: false, meta: { floors: 0 } },
      [planKey(M23)]: { pdf: true, meta: { floors: 0 } },
      [planKey(M6)]: { pdf: true, meta: { floors: 2 } },
    })
    expect(objectAvailability(OBJ, all).gebaeude).toBe('device')
  })

  it('a revision whose metadata is not stored might hide storeys: «part», never «device»', () => {
    const a = objectAvailability(OBJ, held({
      [planKey(M1)]: { pdf: true, meta: null },
      [planKey(M6)]: { pdf: true, meta: { floors: 2 } },
    }))
    expect(a.gebaeude).toBe('part')
  })

  it('storeys known but their PDF not stored → only online; some PDFs → part', () => {
    const none = objectAvailability(OBJ, held({
      [planKey(M1)]: { pdf: false, meta: { floors: 1 } }, [planKey(M23)]: { pdf: false, meta: { floors: 0 } }, [planKey(M6)]: { pdf: false, meta: { floors: 1 } },
    }))
    expect(none.gebaeude).toBe('online')
    const some = objectAvailability(OBJ, held({
      [planKey(M1)]: { pdf: true, meta: { floors: 1 } }, [planKey(M23)]: { pdf: false, meta: { floors: 0 } }, [planKey(M6)]: { pdf: false, meta: { floors: 1 } },
    }))
    expect(some.gebaeude).toBe('part')
  })

  it('nothing known at all → only online; an object without storeys has no Gebäude lamp', () => {
    expect(objectAvailability(OBJ, {}).gebaeude).toBe('online')
    expect(objectAvailability({ plans: [M1], floors: [] }, {}).gebaeude).toBeNull()
  })

  it('the aligned plan goes on the map offline only with its PDF and its alignment metadata', () => {
    expect(objectAvailability(OBJ, held({ [planKey(M23)]: { pdf: true, meta: null } })).georef).toBe(false)
    expect(objectAvailability(OBJ, held({ [planKey(M23)]: { pdf: false, meta: { floors: 0 } } })).georef).toBe(false)
    expect(objectAvailability(OBJ, held({ [planKey(M23)]: { pdf: true, meta: { floors: 0 } } })).georef).toBe(true)
    expect(objectAvailability({ plans: [M1], floors: [] }, held({ [planKey(M1)]: { pdf: true, meta: { floors: 0 } } })).georef).toBe(false)
  })
})

describe('the base map of a view', () => {
  const t = (z: number, x: number, y: number): TileXY => ({ z, x, y })
  const TPL = ['https://a.tiles.example/{z}/{x}/{y}.png', 'https://b.tiles.example/{z}/{x}/{y}.png']

  it('a 256-px raster loads one level above the map zoom, capped by the source', () => {
    expect(rasterTileZoom(15.4)).toBe(16)
    expect(rasterTileZoom(15.6)).toBe(17)
    expect(rasterTileZoom(18.7, 18)).toBe(18)
    expect(rasterTileZoom(-3)).toBe(0)
  })

  it('a zoomed-out view is too many tiles to ask about', () => {
    const near = viewTiles({ west: 7.565, south: 47.52, east: 7.575, north: 47.527 }, 15.5)
    expect(near?.length).toBeGreaterThan(0)
    expect(near!.length).toBeLessThanOrEqual(MAX_VIEW_TILES)
    expect(viewTiles({ west: 5.9, south: 45.8, east: 10.5, north: 47.8 }, 12)).toBeNull()
  })

  it('a tile may be stored under any subdomain template', () => {
    expect(tileUrls(TPL, t(16, 34, 22))).toEqual(['https://a.tiles.example/16/34/22.png', 'https://b.tiles.example/16/34/22.png'])
  })

  it('a tile counts as covered when it or a parent within reach is stored, under any template', async () => {
    const stored = new Set([
      'https://b.tiles.example/16/100/200.png', // the tile itself, under the second host
      'https://a.tiles.example/14/25/50.png', // the grandparent of 16/101/201 (and of 16/100/200)
    ])
    const has = async (u: string) => stored.has(u)
    const tiles = [t(16, 100, 200), t(16, 101, 201), t(16, 400, 400)]
    expect(await missingTiles(tiles, TPL, has)).toEqual([t(16, 400, 400)])
  })

  it('a parent beyond PARENT_DEPTH does not count — MapLibre would not borrow it', async () => {
    const d = PARENT_DEPTH + 1
    const stored = new Set([`https://a.tiles.example/${16 - d}/${100 >> d}/${200 >> d}.png`])
    expect(await missingTiles([t(16, 100, 200)], TPL, async (u) => stored.has(u))).toEqual([t(16, 100, 200)])
  })

  it('a probe that throws is «not stored», never «stored»', async () => {
    expect(await missingTiles([t(16, 1, 1)], TPL, async () => { throw new Error('quota') })).toEqual([t(16, 1, 1)])
  })

  it('a tile ring is the tile\'s square, north-west first', () => {
    const r = tileRing(t(1, 0, 0))
    expect(r).toHaveLength(4)
    expect(r[0][0]).toBeCloseTo(-180)
    expect(r[1][0]).toBeCloseTo(0)
    expect(r[0][1]).toBeGreaterThan(80)
    expect(r[2][1]).toBeCloseTo(0)
  })

  it('share lamps: all → device, some → part, none or nothing asked → only online', () => {
    expect(shareLamp(4, 4)).toBe('device')
    expect(shareLamp(1, 4)).toBe('part')
    expect(shareLamp(0, 4)).toBe('online')
    expect(shareLamp(0, 0)).toBe('online')
  })
})

describe('«Auf diesem Gerät» rows', () => {
  const C = karteCopy.karte.device
  const fmt = { day: (iso: string) => iso.slice(0, 10), size: (b: number) => `${Math.round(b / 1e6)} MB` }
  const base: DeviceFacts = {
    offline: true,
    catalogue: { count: 9, generatedAt: '2026-10-16T08:00:00Z' },
    map: { held: 3, total: 6 },
    plans: { held: 6, total: 9 },
    buildings: 4,
    storageFree: 2_100_000_000,
  }
  const byKey = (f: DeviceFacts) => Object.fromEntries(deviceRows(f, C, fmt).map((r) => [r.key, r]))

  it('the mockup\'s rows in the mockup\'s order', () => {
    expect(deviceRows(base, C, fmt).map((r) => r.key)).toEqual(['catalogue', 'map', 'plans', 'buildings', 'hazmat', 'address', 'weather', 'storage'])
  })

  it('says what was found, with lamps that match', () => {
    const r = byKey(base)
    expect(r.catalogue).toMatchObject({ lamp: 'device', sub: '9 Objekte · suchbar ohne Netz · Stand 2026-10-16' })
    expect(r.map).toMatchObject({ lamp: 'part', sub: C.mapPartOffline })
    expect(r.plans).toMatchObject({ lamp: 'part', sub: '6 von 9 PDFs · zuletzt angesehene' })
    expect(r.buildings).toMatchObject({ lamp: 'part', sub: '4 zuletzt angesehene Gebäude' })
    expect(r.storage).toMatchObject({ lamp: 'device', sub: '2100 MB frei' })
  })

  it('address search, weather and vehicles are always only online; Gefahrgut is bundled', () => {
    const r = byKey(base)
    expect(r.address.lamp).toBe('online')
    expect(r.weather.lamp).toBe('online')
    expect(r.hazmat.lamp).toBe('device')
  })

  it('«cannot tell» is never «on this device»', () => {
    const r = byKey({ ...base, catalogue: null, map: null, plans: null, buildings: 0, storageFree: null })
    expect(r.catalogue).toMatchObject({ lamp: 'online', sub: C.catalogueNone })
    expect(r.map).toMatchObject({ lamp: 'online', sub: C.mapUnknown })
    expect(r.plans).toMatchObject({ lamp: 'online', sub: C.plansUnknown })
    expect(r.buildings).toMatchObject({ lamp: 'online', sub: C.buildingsNone })
    expect(r.storage).toBeUndefined()
  })

  it('the register is never fully on the device: one building is still «part»', () => {
    expect(byKey({ ...base, buildings: 1 }).buildings).toMatchObject({ lamp: 'part', sub: C.buildingsOne })
  })

  it('a whole view and every plan held read «device»; a zoomed-out view asks to zoom in', () => {
    const r = byKey({ ...base, map: { held: 6, total: 6 }, plans: { held: 9, total: 9 } })
    expect(r.map).toMatchObject({ lamp: 'device', sub: C.mapAll })
    expect(r.plans).toMatchObject({ lamp: 'device', sub: 'alle 9 PDFs' })
    expect(byKey({ ...base, map: 'far' }).map).toMatchObject({ lamp: 'part', sub: C.mapFar })
    expect(byKey({ ...base, map: { held: 0, total: 6 } }).map).toMatchObject({ lamp: 'online', sub: C.mapNone })
  })

  it('online, a partial view is not described as hatched', () => {
    expect(byKey({ ...base, offline: false }).map.sub).toBe(C.mapPart)
  })

  it('little free space is flagged', () => {
    expect(byKey({ ...base, storageFree: STORAGE_LOW_BYTES - 1 }).storage.lamp).toBe('part')
  })

  it('a catalogue without plans says so', () => {
    expect(byKey({ ...base, plans: { held: 0, total: 0 } }).plans).toMatchObject({ lamp: 'online', sub: C.plansEmpty })
  })
})

describe('the register answers kept on the device', () => {
  it('a building asked again moves to the front; nothing is dropped below the limit', () => {
    expect(noteBuildingAsked(['a', 'b', 'c'], 'b', 5)).toEqual({ index: ['b', 'a', 'c'], drop: [] })
  })

  it('beyond the limit the oldest are dropped', () => {
    expect(noteBuildingAsked(['a', 'b', 'c'], 'd', 3)).toEqual({ index: ['d', 'a', 'b'], drop: ['c'] })
  })
})
