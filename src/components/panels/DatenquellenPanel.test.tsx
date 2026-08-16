// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'

// What this pins: WHO gets the upload controls, and that «Neue Geo-Ebene …» actually WRITES.
//
// Both writes the panel makes — PUT /api/reference/{id} and the full-document PUT /api/config
// behind `upsertReferenceLayer` — sit behind the deployment admin session, not the editor role.
// Gated on `isEditor` alone (as it was), a plain Bearbeiter saw «Ersetzen» and «Neue Geo-Ebene …»
// and got a 403 every single time; a control that cannot work is worse than one that is not there.
//
// ⚠️ `upsertReferenceLayer` is deliberately NOT mocked any more. It used to be, and that is
// precisely why nobody noticed that it PUT the config without `If-Match` and was therefore
// refused with 428 on every single attempt (see lib/api/reference.test). The transport is mocked
// instead, one layer lower, so the request this panel actually issues is the thing under test.

const { getAdminSession, dataset, apiGet, apiPut, apiUpload, ApiError, toast } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return {
    getAdminSession: vi.fn(),
    apiGet: vi.fn(),
    apiPut: vi.fn(),
    apiUpload: vi.fn(),
    // the panel reports every outcome as a toast, and the toast host is not mounted here
    toast: vi.fn(),
    ApiError,
    dataset: {
      id: 'geo:hydranten', object_id: null, module: null, kind: 'geojson', title: 'Hydranten',
      source_type: 'uploaded', source_note: null, content_type: 'application/geo+json',
      size_bytes: 1024, feature_count: 5, current_version: 1, updated_at: '2026-08-16T08:00:00Z',
    },
  }
})
vi.mock('../../admin/adminAuth', () => ({ getAdminSession }))
vi.mock('../../lib/api', () => ({ apiGet, apiPut, apiUpload, ApiError }))
vi.mock('../../lib/ui', async (orig) => ({ ...(await orig<Record<string, unknown>>()), toast }))
vi.mock('../../lib/incidents', async (orig) => ({
  // ⚠️ the REAL upsertReferenceLayer — see the note above
  ...(await orig<Record<string, unknown>>()),
  listReference: vi.fn(async () => [dataset]),
  listObjects: vi.fn(async () => []),
  uploadReference: vi.fn(),
  inspectGeojson: vi.fn(async () => ({ ok: true, count: 3 })),
}))

import { DatenquellenPanel } from './DatenquellenPanel'

const ds = appConfig.copy.datenquellen

beforeEach(() => {
  getAdminSession.mockReset()
  apiGet.mockReset().mockResolvedValue({ version: 'v-1', integrations: {}, referenceLayers: [] })
  apiPut.mockReset().mockResolvedValue(undefined)
  apiUpload.mockReset().mockResolvedValue(dataset)
  toast.mockReset()
})
afterEach(cleanup)

/** Render the panel and wait until the dataset list has arrived. */
async function open(isEditor: boolean) {
  render(<DatenquellenPanel isEditor={isEditor} incidentCoord={null} onClose={() => {}} />)
  await waitFor(() => expect(screen.getByText(dataset.title)).toBeTruthy())
}

describe('DatenquellenPanel — who may upload', () => {
  it('offers the upload controls to an editor whose browser holds an admin session', async () => {
    getAdminSession.mockResolvedValue({ configured: true, authenticated: true })
    await open(true)
    await waitFor(() => expect(screen.queryByText(ds.replace)).toBeTruthy())
    expect(screen.queryByText(ds.newGeoLayer)).toBeTruthy()
    expect(screen.queryByText(ds.adminOnlyNote)).toBeNull()
  })

  it('gives an editor without an admin session the instruction instead of a button that 403s', async () => {
    getAdminSession.mockResolvedValue({ configured: true, authenticated: false })
    await open(true)
    await waitFor(() => expect(screen.queryByText(ds.adminOnlyNote)).toBeTruthy())
    expect(screen.queryByText(ds.replace)).toBeNull()
    expect(screen.queryByText(ds.newGeoLayer)).toBeNull()
  })

  it('tells a Betrachter nothing about uploading — no control, no note', async () => {
    getAdminSession.mockResolvedValue({ configured: true, authenticated: true })
    await open(false)
    expect(screen.queryByText(ds.replace)).toBeNull()
    expect(screen.queryByText(ds.newGeoLayer)).toBeNull()
    expect(screen.queryByText(ds.adminOnlyNote)).toBeNull()
  })

  it('shows no upload control when the admin probe fails (offline, or no admin surface)', async () => {
    getAdminSession.mockRejectedValue(new Error('offline'))
    await open(true)
    expect(screen.queryByText(ds.replace)).toBeNull()
    expect(screen.queryByText(ds.newGeoLayer)).toBeNull()
  })
})

/** Fill in and submit «Neue Geo-Ebene …». */
async function addLayer() {
  await act(async () => { fireEvent.click(screen.getByText(ds.newGeoLayer)) })
  const file = new File(['{"type":"FeatureCollection","features":[]}'], 'Leitungen.geojson', { type: 'application/geo+json' })
  // ⚠️ the picker INSIDE the add form — the dataset rows above carry their own «Ersetzen» ones
  const picker = document.querySelector<HTMLInputElement>('.ip-addlayer input[type="file"]')!
  await act(async () => { fireEvent.change(picker, { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByText(ds.add)) })
}

describe('DatenquellenPanel — «Neue Geo-Ebene» actually reaches the server', () => {
  beforeEach(() => { getAdminSession.mockResolvedValue({ configured: true, authenticated: true }) })

  it('writes the config WITH the version token — without it the endpoint answers 428 every time', async () => {
    await open(true)
    await addLayer()
    await waitFor(() => expect(apiPut).toHaveBeenCalled())
    const [path, , headers] = apiPut.mock.calls[0]
    expect(path).toBe('/api/config')
    expect(headers).toEqual({ 'If-Match': 'v-1' })
  })

  it('says «changed elsewhere, press again» when the document moved under it', async () => {
    apiPut.mockRejectedValueOnce(new ApiError(409, 'Die Konfiguration wurde inzwischen an anderer Stelle geändert.'))
    await open(true)
    await addLayer()
    await waitFor(() => expect(toast).toHaveBeenCalledWith(ds.layerConflict, expect.anything()))
  })
})
