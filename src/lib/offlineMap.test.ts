// @vitest-environment jsdom
// Hunt 24.11.2026, karte F6–F8 / performance F1 / offline-sync F5: what an offline download stores
// is what the map asks for – the same tile URLs (MapLibre's host choice and WMS bbox), the whole
// GeoJSON crop URL, and the night basemap when the map shows it. The fetch stub is an exact-URL
// store, like the installed service worker; MapLibre's own CanonicalTileID makes the request URLs.
import { createElement } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MapRef } from 'react-map-gl/maplibre'
import { MapLayers } from '../components/MapLayers'
import { useOfflinePrefetch } from '../workspace/useOfflinePrefetch'
import type { LayerDef } from '../types'
import { __resetLayerData } from './layerData'
import { missingTiles } from './karte/availability'
import { predownloadArea, tilesForBounds } from './offlineTiles'

vi.mock('react-map-gl/maplibre', () => ({
  Source: (p: { id: string; children?: React.ReactNode }) => createElement('div', { 'data-source': p.id }, p.children),
  Layer: (p: { layout?: { visibility?: string } }) => createElement('span', { 'data-visibility': p.layout?.visibility }),
}))

// MapLibre's own tile id (its request URL), from the installed package's source – loaded by a
// non-literal path so the type check does not walk MapLibre's sources
const TILE_ID = '../../node_modules/maplibre-gl/src/tile/tile_id.ts'
const { CanonicalTileID } = await import(/* @vite-ignore */ TILE_ID) as {
  CanonicalTileID: new (z: number, x: number, y: number) => { url(urls: readonly string[], pixelRatio: number): string }
}

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
  __resetLayerData()
})

it('the source renderer reads the complete warmed GeoJSON bbox offline', async () => {
  const url = '/api/reference/geo:example?v=1&bbox=7.10000,47.10000,7.20000,47.20000'
  const fetcher = vi.fn(async (key: string) => new Response(
    JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: key === url ? 200 : 503 },
  ))
  vi.stubGlobal('fetch', fetcher)
  render(createElement(MapLayers, {
    layers: [{ id: 'example', group: 'test', label: 'Example', icon: 'test', visible: true,
      vectorKind: 'point', geojson: url }],
    preparedOverlays: [], isVisible: () => true, mapReady: true,
  }))
  await act(async () => {})
  expect(fetcher.mock.calls.map(([key]) => key)).toEqual([url])
})

// The fetch stub acts as an exact-URL tile store, like the installed service worker.
const bounds = { west: 7.535, south: 47.489, east: 7.565, north: 47.511 }
const tiles = tilesForBounds(bounds, 14, 17)
async function download(templates: string[]) {
  const urls = new Set<string>()
  vi.stubGlobal('fetch', async (url: string) => { urls.add(url); return new Response(null, { status: 200 }) })
  const result = await predownloadArea({ templates, bounds, minZoom: 14, maxZoom: 17 })
  expect(result.fetched).toBe(tiles.length)
  return urls
}
const shards = ['a', 'b', 'c', 'd'].map((h) => 'https://' + h + '.example.invalid/day/{z}/{x}/{y}.png')
const wms = ['https://example.invalid/wms?bbox={bbox-epsg-3857}']
for (const [title, templates] of [['sharded raster', shards], ['WMS bounds', wms]] as const) {
  it('an offline download contains the exact keys MapLibre requests for ' + title, async () => {
    const cached = await download(templates)
    // The reference viewer probes XYZ basemaps. Its availability result is meaningful for
    // the sharded base. WMS overlays use the incident's separate reference probe.
    if (templates === shards) {
      const availability = await missingTiles(tiles, templates, async (key) => cached.has(key))
      expect(availability.length).toBe(0)
    }
    const misses = tiles.filter(({ z, x, y }) => !cached.has(new CanonicalTileID(z, x, y).url(templates, 1)))
    expect(misses.length).toBe(0)
  })
}

it('offline preparation downloads the basemap that the night map shows', async () => {
  document.documentElement.dataset.theme = 'night'
  const base: LayerDef = {
    id: 'example-base', label: 'Base', group: 'test', icon: 'map', visible: true, base: true,
    tiles: ['https://base.example.invalid/day/{z}/{x}/{y}.png'],
    nightTiles: ['https://base.example.invalid/night/{z}/{x}/{y}.png'],
  }
  const mapRef = { current: { getMap: () => ({}) } as unknown as MapRef }
  const sources = render(createElement(MapLayers, { layers: [base], preparedOverlays: [],
    isVisible: () => true, mapReady: true })).container
  const active = sources.querySelector('[data-visibility="visible"]')?.parentElement
  expect(active?.dataset.source).toBe('s-example-base-night')
  const cached = new Set<string>()
  vi.stubGlobal('fetch', async (url: string) => { cached.add(url); return new Response(null, { status: 200 }) })
  const h = renderHook(() => useOfflinePrefetch({
    incidentId: 'example', center: [7.55, 47.5], mapRef, layers: [base], backendPlans: {},
  }))
  await act(async () => h.result.current.downloadOffline({ quiet: true }))
  const probes = h.result.current.offlineProbeUrls.tiles
  expect(probes.length).toBeGreaterThan(0)
  expect(probes.every((url) => cached.has(url))).toBe(true)
  expect([...cached].filter((url) => url.includes('/night/')).length).toBeGreaterThan(0)
})

it('a tile stored under another host does not count as there – the map never asks for it', async () => {
  const wrongShard = new Set(tiles.map(({ z, x, y }) => shards[(x + y + 1) % shards.length].replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))))
  const missing = await missingTiles(tiles, shards, async (key) => wrongShard.has(key))
  expect(missing.length).toBeGreaterThan(0)
})

