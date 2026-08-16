import { describe, it, expect, vi, beforeEach } from 'vitest'

// `upsertReferenceLayer` is the ONE browser route that adds a reference layer without the CLI
// — the field app's Datenquellen panel, «Neue Geo-Ebene …». It writes the deployment config
// with the full-document PUT, and that endpoint refuses a browser request carrying no version
// token with 428 (api/config · put_config; `fetch` always sends `Sec-Fetch-Site`, so every call
// from this file counts as a browser).
//
// It sent none. Confirmed against a running station on 2026-08-16: the identical body answered
// 428 «Diese Seite ist veraltet» without the header and 200 with it — so «Neue Geo-Ebene …» had
// never once worked since the guard shipped. Nothing caught it, because the panel's own test
// mocked this function away; a mock that cannot fail is not coverage.
//
// So this file exercises the real function against a mocked TRANSPORT, which is where the
// contract actually lives: what headers go out, and what happens when the document moved.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../api', () => ({ apiGet, apiPut, apiUpload: vi.fn(), ApiError }))

import { geoDatasetId, geoLayerUrl, referenceUrl, upsertReferenceLayer } from './reference'
import { appConfig } from '../../config/appConfig'

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

/** The stored document as GET answers it: a version token and one CLI-written layer whose
 *  night colour and auto-activation this form never shows. */
const STORED = {
  version: 'v-abc123',
  integrations: { divera: true },
  referenceLayers: [
    {
      id: 'hydranten', label: 'Hydranten', kind: 'geojson', geojson: '/api/reference/geo:hydranten',
      color: '#0f52b5', nightColor: '#7fb2ff', autoActivate: ['Brandbekämpfung'],
    },
  ],
}

/** headers / body of the last PUT. */
const lastPut = () => {
  const call = apiPut.mock.calls[apiPut.mock.calls.length - 1]
  return { body: call?.[1] as Record<string, unknown>, headers: call?.[2] as Record<string, string> | undefined }
}

beforeEach(() => {
  apiGet.mockReset().mockImplementation(async () => structuredClone(STORED))
  apiPut.mockReset().mockResolvedValue(undefined)
})

describe('upsertReferenceLayer — the If-Match contract', () => {
  it('sends the version it just read as If-Match (without it the endpoint answers 428)', async () => {
    await upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/api/reference/geo:neu' })
    expect(lastPut().headers).toEqual({ 'If-Match': 'v-abc123' })
  })

  it('still strips the env-derived integrations block', async () => {
    await upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/api/reference/geo:neu' })
    expect(lastPut().body.integrations).toBeUndefined()
  })

  it('merges over an existing row, so a CLI-written nightColor / autoActivate survives a re-upload', async () => {
    await upsertReferenceLayer({
      id: 'hydranten', label: 'Hydranten (neu)', kind: 'geojson', geojson: '/api/reference/geo:hydranten',
    })
    const layers = lastPut().body.referenceLayers as Record<string, unknown>[]
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({
      label: 'Hydranten (neu)', nightColor: '#7fb2ff', autoActivate: ['Brandbekämpfung'],
    })
  })

  it('reports a 409 as «changed elsewhere, press again» rather than the raw endpoint sentence', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(409, 'Die Konfiguration wurde inzwischen an anderer Stelle geändert.'))
    await expect(upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/x' }))
      .rejects.toMatchObject({ status: 409, detail: appConfig.copy.datenquellen.layerConflict })
  })

  it('passes any other failure through untouched — a 401 is not a conflict', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(401, 'Admin-Anmeldung erforderlich'))
    await expect(upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/x' }))
      .rejects.toMatchObject({ status: 401, detail: 'Admin-Anmeldung erforderlich' })
  })

  // ⚠️ NO token is not the same event as a stale one, and the fallback treated it as one. GET
  // /api/config always answers with a `version` — `_version()` hashes the stored document, and
  // hashes `{}` for a station nobody has ever written — so a missing one means the response was
  // not the config document at all: a captive portal, a proxy error page, an offline shell. The
  // header was then simply left off, the endpoint answered 428, and the caller relabelled that
  // «gerade an anderer Stelle geändert. Bitte nochmals «Hinzufügen» drücken» — an instruction
  // that can never resolve, because pressing again reads the same non-answer.
  for (const broken of [{ referenceLayers: [] }, { version: '', referenceLayers: [] }, { version: 42 }]) {
    it(`refuses to write at all when the read answered no version token (${JSON.stringify(broken)})`, async () => {
      apiGet.mockResolvedValueOnce(broken)
      await expect(upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/x' }))
        .rejects.toMatchObject({ status: 428, detail: appConfig.copy.datenquellen.layerNoVersion })
      // the important half: no unguarded full-document write went out
      expect(apiPut).not.toHaveBeenCalled()
    })
  }

  it('says something a second press could fix ONLY when a second press could fix it', async () => {
    apiGet.mockResolvedValueOnce({ referenceLayers: [] })
    const noToken = await upsertReferenceLayer({ id: 'neu', label: 'Neu', kind: 'geojson', geojson: '/x' })
      .catch((e: Error) => e.message)
    expect(noToken).not.toBe(appConfig.copy.datenquellen.layerConflict)
  })
})
