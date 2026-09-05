// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Raster-Ebenen (WMS/WMTS) — the one reference layer a canton hands over ready-made, and the one
// that had no browser field at all: the Kartenebenen page was a viewer, and the field app's
// Datenquellen panel starts from a file upload, which a raster layer does not have.
//
// Two rules decide whether this editor is safe, and both are here:
//   · `referenceLayers` has THREE writers (admin_geodata, this page, the field panel), so an edit
//     must MERGE over the stored row — `nightColor`, `opacity`, `autoActivate` and the rest are
//     CLI-written and invisible here, and rebuilding the row would delete them.
//   · a raster layer without `tiles` is refused by the API (schemas.py · ReferenceLayerConfig),
//     and this page PUTs the WHOLE document — so the empty row «hinzufügen» creates must not
//     reach the draft.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))
// the page also lists loaded datasets + the merged Geodaten view; neither is under test here
vi.mock('../lib/incidents', () => ({ listReference: vi.fn(async () => []), listObjects: vi.fn(async () => []) }))
vi.mock('./DataView', () => ({ GeodataView: () => null, ObjectsView: () => null }))

import { ConfigProvider } from './ConfigContext'
import { LayersSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.layers

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
const sentLayers = () => {
  const body = apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as { referenceLayers?: any[] } | undefined
  return body?.referenceLayers
}
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })

/** A station whose layers were written by the CLI: one vector layer this editor must not touch,
 *  and one raster layer carrying three fields this form never shows. */
const STATION = {
  version: 'v1',
  referenceLayers: [
    { id: 'hydranten', label: 'Hydranten', kind: 'geojson', geojson: '/api/reference/geo:hydranten', color: '#0f52b5' },
    {
      id: 'leitungen', label: 'Leitungskataster', group: 'Kanton', kind: 'wms', icon: 'map',
      tiles: ['https://geowms.bl.ch/?LAYERS=lk&BBOX={bbox-epsg-3857}'],
      nightColor: '#7fb2ff', opacity: 0.6, autoActivate: ['Brandbekämpfung'], attribution: '© Kanton BL',
    },
  ],
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup(cfg: unknown = STATION) {
  apiGet.mockResolvedValue(structuredClone(cfg))
  await act(async () => { render(<ConfigProvider><LayersSection /></ConfigProvider>) })
  await waitFor(() => expect(screen.queryByText(C.rasterAdd)).toBeTruthy())
}

/** The label input of the (single) raster row on screen. */
const labelBox = () => screen.getByPlaceholderText(C.rasterLabelPlaceholder)
const tilesBox = () => screen.getByPlaceholderText(C.rasterTilesPlaceholder)

describe('Raster-Ebenen — editing one must not delete what the CLI wrote', () => {
  it('keeps nightColor / opacity / autoActivate when only the label is corrected', async () => {
    await setup()
    await type(labelBox(), 'Leitungskataster BL')
    await settle()
    const raster = sentLayers()!.find((l) => l.id === 'leitungen')
    expect(raster).toMatchObject({
      label: 'Leitungskataster BL',
      nightColor: '#7fb2ff', opacity: 0.6, autoActivate: ['Brandbekämpfung'],
    })
  })

  it('leaves the GeoJSON layer beside it exactly as it was', async () => {
    await setup()
    await type(labelBox(), 'Leitungskataster BL')
    await settle()
    expect(sentLayers()!.find((l) => l.id === 'hydranten')).toEqual(STATION.referenceLayers[0])
  })

  it('shows only raster layers — a GeoJSON one needs a file and is edited elsewhere', async () => {
    await setup()
    expect(screen.queryAllByPlaceholderText(C.rasterLabelPlaceholder)).toHaveLength(1)
  })
})

describe('Raster-Ebenen — an incomplete row must not 422 the whole document', () => {
  it('holds back the empty row «hinzufügen» creates, and says why', async () => {
    await setup()
    await act(async () => { fireEvent.click(screen.getByText(C.rasterAdd)) })
    await settle()
    expect(screen.getByText(C.rasterIncomplete)).toBeTruthy()
    // nothing has changed for the server: the stored two layers are still the stored two layers
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('a URL template alone is not enough — the id and the label belong with it', async () => {
    await setup()
    await act(async () => { fireEvent.click(screen.getByText(C.rasterAdd)) })
    const boxes = screen.queryAllByPlaceholderText(C.rasterTilesPlaceholder)
    await type(boxes[1], 'https://wmts.example.ch/{z}/{x}/{y}.png')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(C.rasterIncomplete)).toBeTruthy()
  })

  it('stores the row the moment it is complete — the id following the label on its own', async () => {
    await setup({ version: 'v1', referenceLayers: [] })
    await act(async () => { fireEvent.click(screen.getByText(C.rasterAdd)) })
    await type(labelBox(), 'Zonenplan')
    await type(tilesBox(), 'https://wmts.example.ch/{z}/{x}/{y}.png')
    await settle()
    expect(sentLayers()).toEqual([{
      id: 'zonenplan', label: 'Zonenplan', kind: 'wms', icon: 'map',
      tiles: ['https://wmts.example.ch/{z}/{x}/{y}.png'],
    }])
  })

  it('refuses a duplicate id rather than quietly making two layers one', async () => {
    await setup()
    await act(async () => { fireEvent.click(screen.getByText(C.rasterAdd)) })
    const labels = screen.queryAllByPlaceholderText(C.rasterLabelPlaceholder)
    const tiles = screen.queryAllByPlaceholderText(C.rasterTilesPlaceholder)
    await type(labels[1], 'Zweiter Kataster')
    await type(tiles[1], 'https://wmts.example.ch/{z}/{x}/{y}.png')
    await settle()
    expect(sentLayers()).toHaveLength(3) // complete and unique → stored
    // …and the moment its id collides with the first one it drops back OUT of the document
    await type(screen.queryAllByPlaceholderText(C.rasterIdPlaceholder)[1], 'leitungen')
    await settle()
    expect(screen.getByText(C.rasterDuplicate)).toBeTruthy()
    expect(sentLayers()?.filter((l) => l.id === 'leitungen')).toHaveLength(1)
  })
})
