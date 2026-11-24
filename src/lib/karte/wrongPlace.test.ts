// @vitest-environment jsdom
// Hunt 24.11.2026, karte F1, F4, F3: the right building's sheet, the right town's object, the
// night distance after reopening Gefahrgut.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useKarteTools } from '../../components/karte/useKarteTools'
import type { LngLat, PlanDocument } from '../../types'
import type { StationObject } from '../api/stationReference'
import { __setErgData } from '../erg'
import { ergRingsFor, isErgDay } from '../ergRings'
import { twinPlanImageLayerId } from '../georefTwins'
import { useGeorefFits } from '../useGeorefFits'
import { stationOverlays } from './overlays'
import { objectAtAddress } from './places'

vi.mock('../pdfRaster', async (load) => ({
  ...await load<typeof import('../pdfRaster')>(),
  planPreviewUrl: async (url: string) => 'raster:' + url,
}))
vi.mock('../stationPlanScale', async (load) => ({
  ...await load<typeof import('../stationPlanScale')>(),
  georefForPlan: (key: string) => {
    const lng = key === 'building-a' ? 7.5 : 7.6
    return { pairs: [
      { plan: { x: 0, y: 0 }, lngLat: { lng, lat: 47.5 } },
      { plan: { x: 1, y: 0 }, lngLat: { lng: lng + 0.001, lat: 47.5 } },
    ] }
  },
}))

afterEach(() => { cleanup(); vi.useRealTimers() })

it('a change of building displays that building’s sheet in the same module slot', async () => {
  const sheet = (key: string): PlanDocument => ({
    id: 'modul2', code: 'M2', title: key, subtitle: '', orientation: 'landscape',
    georefKey: key, imageUrl: '/synthetic/' + key + '.pdf',
  })
  const a = sheet('building-a'), b = sheet('building-b')
  const args: Parameters<typeof useGeorefFits>[0] = {
    planDocs: [a], planScale: {}, building: null, setBuilding: vi.fn(), planBindings: [],
    activeObjectId: 'building-a', board: {}, objects: [], rebake: vi.fn(),
    planFitsRef: { current: new Map() }, fitsVersion: 0, setFitsVersion: vi.fn(),
    stepLabelRef: { current: null }, histSide: { current: { log: vi.fn() } }, readOnly: true,
    canWriteBlob: false, tacticalLocked: true, replayActive: false,
    twinLayers: { [twinPlanImageLayerId(a.id)]: true }, twinLayerOpacity: {},
    activePlanId: a.id, liveVehicles: [], livePeople: { people: [] }, isVisible: () => true,
    mapEntities: [],
  }
  const h = renderHook((props) => useGeorefFits(props), { initialProps: args })
  await waitFor(() => expect(h.result.current.georefPlanRasters[0]?.url).toBe('raster:' + a.imageUrl))
  h.rerender({ ...args, activeObjectId: 'building-b', planDocs: [b] })
  await act(async () => {})
  const raster = h.result.current.georefPlanRasters[0]
  expect(raster.coordinates[0][0]).toBeCloseTo(7.6, 5)
  expect(raster.url).toBe('raster:' + b.imageUrl)
})

it('selecting an address keeps the selected municipality', () => {
  const object = (id: string, locality: string, lng: number): StationObject => ({
    id, kind: 'objekt', name: id, address: 'Bahnhofstrasse 8', locality, lat: 47.5, lng,
    aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null,
  })
  const west = object('west-building', 'Westdorf', 7.5), east = object('east-building', 'Ostdorf', 7.6)
  west.kind = 'einsatzobjekt'
  west.plans = [{ id: 'plan:west:modul2', module: 'modul2', code: '2', title: 'West',
    pages: 1, georef: true, version: 1 }]
  expect(objectAtAddress([west, east], 'Bahnhofstrasse 8, 9992 Ostdorf')?.id).toBe(east.id)
})

it('reopening an unchanged reference-map lookup after dark draws the nighttime distance', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-24T11:00:00Z'))
  const coord: LngLat = [7.5, 47.5]
  const row = { si: '10 m', pd: '100 m', pn: '200 m' }
  __setErgData({ version: 'synthetic', un: { '9999': { tih: [row] } } })
  const h = renderHook(() => useKarteTools(null))
  act(() => h.result.current.toggleTool('erg', () => coord))
  act(() => h.result.current.setErg((e) => ({ ...e, un: '9999', at: new Date() })))
  const rings = () => stationOverlays({
    outlines: new Map(), cats: new Map(), hidden: () => false, ink: '#000', blue: '#00f', hatchInk: '#111',
    sel: null, selId: null, ringsNear: () => [], underground: null, uncached: [],
    erg: h.result.current.tool === 'erg' ? h.result.current.erg : null,
  })
  const radius = () => {
    const ring = rings().find((o) => o.id === 'karte-erg-protect')
    return ring?.kind === 'circle' ? ring.radiusM : null
  }
  expect(isErgDay(new Date(), coord)).toBe(true)
  expect(radius()).toBe(100)
  act(() => h.result.current.toggleTool('erg', () => coord))
  vi.setSystemTime(new Date('2026-11-24T21:00:00Z'))
  act(() => h.result.current.toggleTool('erg', () => coord))
  expect(isErgDay(new Date(), coord)).toBe(false)
  const expected = ergRingsFor(row, 'small', new Date(), coord).find((r) => r.kind === 'protect')
  expect(radius()).toBe(expected?.radiusM)
})

it('a home-town object without a town matches its home address, whatever the canton suffix', () => {
  const o = (id: string, address: string, locality: string | null = null): StationObject => ({
    id, kind: 'objekt', name: id, address, locality, lat: 47.5, lng: 7.5,
    aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null,
  } as StationObject)
  expect(objectAtAddress([o('home', 'Hauptstrasse 10')], 'Hauptstrasse 10, 4104 Oberwil', '4104 Oberwil BL')?.id).toBe('home')
  // the town in the object's own address counts when it has no locality
  expect(objectAtAddress([o('east', 'Bahnhofstrasse 8, 9992 Ostdorf'), o('west', 'Bahnhofstrasse 8, 9991 Westdorf')],
    'Bahnhofstrasse 8, 9991 Westdorf', '9999 Musterdorf')?.id).toBe('west')
  // a search without a town at a door two towns share names neither
  expect(objectAtAddress([o('east', 'Bahnhofstrasse 8', 'Ostdorf'), o('west', 'Bahnhofstrasse 8', 'Westdorf')],
    'Bahnhofstrasse 8', '9999 Musterdorf')).toBeNull()
})
