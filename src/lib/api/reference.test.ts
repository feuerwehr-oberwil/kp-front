import { describe, it, expect } from 'vitest'

import { geoDatasetId, geoLayerUrl, referenceUrl } from './reference'

// A Modul-PDF is REPLACED in place: `store_plan` writes new bytes and bumps `current_version`,
// but the dataset id — and so the URL — stays the same. Three caches key on that URL (the
// service worker's `reference-data` entry, pdf.js' document cache, the bitmap cache), so a
// re-uploaded plan kept rendering the sheet it replaced. The version is the cache key.
describe('referenceUrl', () => {
  it('carries the version when one is given', () => {
    expect(referenceUrl('plan:abc:modul1', 3)).toBe('/api/reference/plan%3Aabc%3Amodul1?v=3')
    // a fresh upload is a DIFFERENT url — which is the whole mechanism
    expect(referenceUrl('plan:abc:modul1', 4)).not.toBe(referenceUrl('plan:abc:modul1', 3))
  })

  it('stays bare without one — geojson/symbols are fetched by id and revalidate normally', () => {
    expect(referenceUrl('geo:hydrant')).toBe('/api/reference/geo%3Ahydrant')
    expect(referenceUrl('symbols:tactical')).toBe('/api/reference/symbols%3Atactical')
  })

  it('version 0 is a version, not «no version»', () => {
    expect(referenceUrl('plan:abc:modul1', 0)).toBe('/api/reference/plan%3Aabc%3Amodul1?v=0')
  })
})

// The URL that goes INTO the deployment config is a different string from the one a fetch uses:
// it is matched literally by two consumers, so the colon must survive it.
describe('geoLayerUrl / geoDatasetId — the shape the config stores', () => {
  it('leaves `geo:` unencoded, the way the CLI writes it and two consumers match it', () => {
    // IncidentWorkspace · withGeoBbox tests for '/api/reference/geo:' before appending the
    // offline crop; the Kartenebenen viewer pulls the dataset id out of the same string.
    expect(geoLayerUrl('geo:hydrant')).toBe('/api/reference/geo:hydrant')
    expect(geoLayerUrl('geo:hydrant')).not.toContain('%3A')
  })

  it('carries the version, because a replaced file keeps the dataset id', () => {
    expect(geoLayerUrl('geo:hydrant', 2)).toBe('/api/reference/geo:hydrant?v=2')
    expect(geoLayerUrl('geo:hydrant', 2)).not.toBe(geoLayerUrl('geo:hydrant', 1))
  })

  it('reads the dataset back out — with or without the version, and never from an external URL', () => {
    expect(geoDatasetId('/api/reference/geo:hydrant?v=3')).toBe('geo:hydrant')
    expect(geoDatasetId('/api/reference/geo:leitungs_kataster-2026')).toBe('geo:leitungs_kataster-2026')
    expect(geoDatasetId('https://geo.example.ch/hydranten.geojson')).toBeNull()
    expect(geoDatasetId(undefined)).toBeNull()
  })
})
