// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// GeoJSON-Ebenen on the Kartenebenen page — the last station dataset that needed a terminal.
//
// What decides whether this surface is safe, and what each test here holds:
//   · BOTH halves or nothing. A file in the store with no config row renders nothing; a config
//     row with no file is a layer that 404s. The upload does what `admin_geodata load` does.
//   · WGS84 only. LV95 is what a Swiss export hands over, and relabelling projected metres as
//     lat/lng puts a station's hydrants in the North Sea — so the file is read BEFORE a byte is
//     sent, and the refusal names the reprojection, not just the failure.
//   · Replacing a file updates the dataset IN PLACE (same id → new version) and writes that
//     version into the layer URL, which is the only cache key the service worker ever sees.
//   · `referenceLayers` has three writers, so an edit MERGES over the stored row: `nightColor`,
//     `opacity` and `autoActivate` are CLI-written and invisible in this form.

const { apiGet, apiPut, apiUpload, ApiError, listReference, refs } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  // The station's loaded datasets, as `/api/reference` answers them. Mutable per test: a replace
  // is only believable if the list the page re-reads afterwards carries the NEW version.
  const refs: { rows: Record<string, unknown>[] } = { rows: [] }
  return {
    apiGet: vi.fn(), apiPut: vi.fn(), apiUpload: vi.fn(), ApiError,
    refs, listReference: vi.fn(async () => refs.rows),
  }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, apiUpload, ApiError }))
vi.mock('../lib/incidents', () => ({ listReference, listObjects: vi.fn(async () => []) }))
vi.mock('./DataView', () => ({ GeodataView: () => null, ObjectsView: () => null }))

import { ConfigProvider } from './ConfigContext'
import { LayersSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.layers

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
const configPuts = () => apiPut.mock.calls.filter((c) => c[0] === '/api/config')
const sentLayers = () => {
  const body = configPuts()[configPuts().length - 1]?.[1] as
    { referenceLayers?: Record<string, unknown>[] } | undefined
  return body?.referenceLayers
}
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })
const click = async (el: Element) => { await act(async () => { fireEvent.click(el) }) }

const dataset = (id: string, version: number, features: number) => ({
  id, object_id: null, module: null, kind: 'geojson', title: id, source_type: 'uploaded',
  source_note: null, content_type: 'application/geo+json', size_bytes: 1024,
  feature_count: features, current_version: version, updated_at: '2026-08-16T09:00:00Z',
})

/** A two-point hydrant export in WGS84 — what a station is supposed to hand over. */
const WGS84 = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [7.5361, 47.4841] }, properties: {} },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [7.5372, 47.4855] }, properties: {} },
  ],
})
/** …and the same data as it actually arrives: LV95 E/N, metres, silently mislabelled lng/lat. */
const LV95 = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2611000, 1264000] }, properties: {} }],
})

const geojsonFile = (body: string, name = 'hydranten.geojson') =>
  new File([body], name, { type: 'application/geo+json' })

/** A station whose layers were written by the CLI: one vector layer carrying three fields this
 *  form never shows, plus the raster layer that shares the array with it. */
const STATION = {
  version: 'v1',
  referenceLayers: [
    {
      id: 'hydranten', label: 'Hydranten', group: 'Wasser', kind: 'geojson',
      geojson: '/api/reference/geo:hydranten', vectorKind: 'point', color: '#0f52b5',
      nightColor: '#7fb2ff', opacity: 0.8, autoActivate: ['Brandbekämpfung'],
    },
    {
      id: 'leitungen', label: 'Leitungskataster', kind: 'wms', icon: 'map',
      tiles: ['https://geowms.bl.ch/?LAYERS=lk&BBOX={bbox-epsg-3857}'],
    },
  ],
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  refs.rows = [dataset('geo:hydranten', 1, 2)]
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
  apiUpload.mockReset()
  listReference.mockClear()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(cfg: unknown = STATION) {
  apiGet.mockResolvedValue(structuredClone(cfg))
  const view = await act(async () => render(<ConfigProvider><LayersSection /></ConfigProvider>))
  await waitFor(() => expect(screen.queryByText(C.geojsonAdd)).toBeTruthy())
  return view
}

/** The add form's file input (the only one on screen until a layer row offers «Datei ersetzen»). */
const addFileInput = (c: HTMLElement) => c.querySelectorAll('input[type="file"]')

describe('GeoJSON-Ebene hochladen — both halves, or neither', () => {
  it('stores the file AND writes the layer, with the version in its URL', async () => {
    refs.rows = [] // a station with nothing loaded yet
    const { container } = await setup({ version: 'v1', referenceLayers: [] })
    apiUpload.mockResolvedValue(dataset('geo:hydranten', 1, 2))
    await click(screen.getByText(C.geojsonAdd))
    await act(async () => {
      fireEvent.change(addFileInput(container)[0], { target: { files: [geojsonFile(WGS84)] } })
    })
    // what the file CONTAINS is on screen before anything is committed
    await waitFor(() => expect(screen.getByText(/2 Features/)).toBeTruthy())
    await type(screen.getByPlaceholderText(C.geojsonLabelPlaceholder), 'Hydranten')
    await click(screen.getByText(C.geojsonUpload))
    await settle()

    // half one: the file, under the dataset id derived from the Kennung
    expect(apiUpload).toHaveBeenCalledTimes(1)
    expect(apiUpload.mock.calls[0][0]).toBe('/api/reference/geo%3Ahydranten')
    expect(apiUpload.mock.calls[0][2]).toBe('PUT')
    // half two: the render config, pointing at that dataset — with the version as the cache key
    expect(sentLayers()).toEqual([{
      id: 'hydranten', label: 'Hydranten', group: undefined, icon: 'map', kind: 'geojson',
      geojson: '/api/reference/geo:hydranten?v=1', vectorKind: 'point', color: '#0f52b5',
    }])
  })

  it('refuses an LV95 file before it is uploaded, and names the reprojection', async () => {
    const { container } = await setup({ version: 'v1', referenceLayers: [] })
    await click(screen.getByText(C.geojsonAdd))
    await act(async () => {
      fireEvent.change(addFileInput(container)[0], { target: { files: [geojsonFile(LV95, 'lv95.geojson')] } })
    })
    // the refusal names the projection AND the way out of it, in one line
    await waitFor(() => expect(screen.getByText(new RegExp(C.geojsonReproject.slice(0, 30)))).toBeTruthy())
    expect(screen.getByText(new RegExp(C.geojsonReproject.slice(0, 30))).textContent).toMatch(/LV95/)
    await settle()
    // nothing was sent — not the file, not the document
    expect(apiUpload).not.toHaveBeenCalled()
    expect(configPuts()).toHaveLength(0)
  })

  it('holds a picked file back until it has a Bezeichnung', async () => {
    const { container } = await setup({ version: 'v1', referenceLayers: [] })
    await click(screen.getByText(C.geojsonAdd))
    await act(async () => {
      fireEvent.change(addFileInput(container)[0], { target: { files: [geojsonFile(WGS84, '.geojson')] } })
    })
    await settle()
    expect(screen.getByText(C.geojsonIncomplete)).toBeTruthy()
    expect((screen.getByText(C.geojsonUpload) as HTMLButtonElement).disabled).toBe(true)
    expect(apiUpload).not.toHaveBeenCalled()
    expect(configPuts()).toHaveLength(0)
  })
})

describe('Datei ersetzen — a new version of the same dataset, not a second one', () => {
  it('re-uploads under the stored dataset id and carries the new version into the URL', async () => {
    const { container } = await setup()
    apiUpload.mockResolvedValue(dataset('geo:hydranten', 2, 3))
    refs.rows = [dataset('geo:hydranten', 2, 3)]
    const inputs = addFileInput(container)
    await act(async () => {
      fireEvent.change(inputs[0], { target: { files: [geojsonFile(WGS84, 'hydranten-neu.geojson')] } })
    })
    await settle()

    expect(apiUpload.mock.calls[0][0]).toBe('/api/reference/geo%3Ahydranten') // same id → same row
    const layers = sentLayers()!
    expect(layers.filter((l) => String(l.geojson).includes('geo:hydranten'))).toHaveLength(1)
    expect(layers.find((l) => l.id === 'hydranten')!.geojson).toBe('/api/reference/geo:hydranten?v=2')
    // …and the page re-reads the datasets, so the version on screen is the stored one
    await waitFor(() => expect(screen.getAllByText(/Version 2/).length).toBeGreaterThan(0))
  })
})

describe('editing a GeoJSON layer must not delete what the CLI wrote', () => {
  it('keeps nightColor / opacity / autoActivate when only the label is corrected', async () => {
    await setup()
    await type(screen.getByPlaceholderText(C.geojsonLabelPlaceholder), 'Hydranten Steintal')
    await settle()
    expect(sentLayers()!.find((l) => l.id === 'hydranten')).toMatchObject({
      label: 'Hydranten Steintal', nightColor: '#7fb2ff', opacity: 0.8, autoActivate: ['Brandbekämpfung'],
      geojson: '/api/reference/geo:hydranten',
    })
  })

  it('leaves the raster layer beside it exactly as it was', async () => {
    await setup()
    await type(screen.getByPlaceholderText(C.geojsonLabelPlaceholder), 'Hydranten Steintal')
    await settle()
    expect(sentLayers()!.find((l) => l.id === 'leitungen')).toEqual(STATION.referenceLayers[1])
  })
})

// ⚠️ The two-editor bug again, in TIME rather than in space. An upload takes as long as the
// station's uplink takes — a replaced 10 MB export on LTE is ten seconds and more — and nothing
// on this page is disabled meanwhile. Both async writers used to hand over the layer list they
// captured at CLICK time, so whatever was edited during the upload was silently put back: the
// label being corrected reverted to what it said before, a raster layer added meanwhile
// disappeared from the document (its tiles still configured nowhere). Neither was announced,
// and the operator's own screen showed the value they had just typed.
describe('an upload in flight must not put the page back the way it found it', () => {
  /** An upload that only finishes when the test says so. */
  function deferredUpload<T>() {
    let resolve!: (v: T) => void
    apiUpload.mockReturnValue(new Promise<T>((r) => { resolve = r }))
    return { finish: async (v: T) => { resolve(v); await act(async () => { await Promise.resolve() }) } }
  }

  it('keeps a label corrected while a replacement file was uploading', async () => {
    const { container } = await setup()
    const upload = deferredUpload<Record<string, unknown>>()
    refs.rows = [dataset('geo:hydranten', 2, 3)]
    await act(async () => {
      fireEvent.change(addFileInput(container)[0], { target: { files: [geojsonFile(WGS84, 'neu.geojson')] } })
    })
    // …the operator carries on working, because nothing stops them
    await type(screen.getByPlaceholderText(C.geojsonLabelPlaceholder), 'Hydranten Steintal')
    await settle()
    expect(sentLayers()!.find((l) => l.id === 'hydranten')!.label).toBe('Hydranten Steintal')

    await upload.finish(dataset('geo:hydranten', 2, 3))
    await settle()
    const row = sentLayers()!.find((l) => l.id === 'hydranten')!
    expect(row.geojson).toBe('/api/reference/geo:hydranten?v=2') // the replacement did land
    expect(row.label).toBe('Hydranten Steintal')                 // …and did not undo the label
  })

  it('keeps a raster layer added while a NEW GeoJSON layer was uploading', async () => {
    const { container } = await setup({ version: 'v1', referenceLayers: [] })
    await click(screen.getByText(C.geojsonAdd))
    await act(async () => {
      fireEvent.change(addFileInput(container)[0], { target: { files: [geojsonFile(WGS84)] } })
    })
    await waitFor(() => expect(screen.getByText(/2 Features/)).toBeTruthy())
    await type(screen.getByPlaceholderText(C.geojsonLabelPlaceholder), 'Hydranten')

    const upload = deferredUpload<Record<string, unknown>>()
    await click(screen.getByText(C.geojsonUpload))
    // meanwhile, in the editor below: a new WMS row, filled in far enough to be stored
    await click(screen.getByText(C.rasterAdd))
    await type(screen.getByPlaceholderText(C.rasterLabelPlaceholder), 'Leitungskataster')
    await type(screen.getByPlaceholderText(C.rasterTilesPlaceholder), 'https://geowms.bl.ch/?LAYERS=lk')
    await settle()
    expect(sentLayers()!.map((l) => l.id)).toEqual(['leitungskataster'])

    await upload.finish(dataset('geo:hydranten', 1, 2))
    await settle()
    // both halves survive: the uploaded layer is appended to the list as it is NOW
    expect(sentLayers()!.map((l) => l.id)).toEqual(['leitungskataster', 'hydranten'])
  })
})
