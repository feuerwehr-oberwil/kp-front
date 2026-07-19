// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { ApiError } from '../lib/api'

// Mock the data layer + api so the card states are deterministic. Playwright is not
// part of this repo's toolchain, so this component test stands in for the live e2e:
// it drives the three Daten pages through data / empty / unconfigured / error states
// and asserts each renders without crashing. They are separate nav destinations now,
// so the test mounts all three together (DataView component is the union for coverage).
const apiGet = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (p: string) => apiGet(p) }
})

const listObjects = vi.fn()
const listReference = vi.fn()
const listPersonnel = vi.fn()
const getDiveraPool = vi.fn()
const refreshDiveraPool = vi.fn()
vi.mock('../lib/incidents', () => ({
  listObjects: () => listObjects(),
  listReference: () => listReference(),
  listPersonnel: () => listPersonnel(),
  getDiveraPool: () => getDiveraPool(),
  refreshDiveraPool: () => refreshDiveraPool(),
}))

// The objects map is lazy-loaded MapLibre (needs WebGL) — stub it out for jsdom.
vi.mock('./ObjectsMap', () => ({ default: () => <div data-testid="objects-map" /> }))

import { DiveraView, TraccarView, ObjectsView, GeodataView } from './DataView'

/** Union of the Daten pages — they share no state, so mounting together is safe. */
function DataView() {
  return (
    <>
      <DiveraView />
      <TraccarView />
      <ObjectsView />
      <GeodataView />
    </>
  )
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

describe('DataView — all wired up', () => {
  it('renders Divera pool, Traccar vehicles, objects + reference', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({
        integrations: { diveraConfigured: true, traccarConfigured: true },
      })
      if (path === '/api/traccar/status') return Promise.resolve({ configured: true })
      if (path === '/api/traccar/positions') return Promise.resolve([
        { device_id: 1, device_name: 'A', unique_id: 'a', status: 'online', latitude: 0, longitude: 0, last_update: '' },
        { device_id: 2, device_name: 'B', unique_id: 'b', status: 'offline', latitude: 0, longitude: 0, last_update: '' },
      ])
      return Promise.reject(new ApiError(404, 'nope'))
    })
    getDiveraPool.mockResolvedValue([{ id: '1' }, { id: '2' }, { id: '3' }])
    listPersonnel.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    listObjects.mockResolvedValue([
      {
        id: 'o1', name: 'Schulhaus', address: 'Hauptstr. 1', lat: 0, lng: 0, source_note: null,
        updated_at: '2026-01-02T00:00:00Z', distance_m: null,
        plans: [{ id: 'pl1', module: 'modul1', kind: 'pdf', current_version: 3, updated_at: '2026-01-02T00:00:00Z', source_type: 's', source_note: null, content_type: null, size_bytes: 10, feature_count: null, object_id: 'o1', title: 'Übersicht' }],
      },
    ])
    listReference.mockResolvedValue([
      { id: 'hydranten', object_id: null, module: null, kind: 'geojson', title: 'Hydranten', source_type: 'export', source_note: 'BL', content_type: 'application/json', size_bytes: 2048, feature_count: 42, current_version: 1, updated_at: '2026-01-02T00:00:00Z' },
    ])

    render(<DataView />)

    expect(await screen.findByText(/3 Alarme im Pool/)).toBeTruthy()
    expect(await screen.findByText(/2 Fahrzeuge/)).toBeTruthy()
    expect(screen.getByText(/1 online/)).toBeTruthy()
    expect(await screen.findByText('Schulhaus')).toBeTruthy()
    expect(screen.getByText('modul1')).toBeTruthy()
    expect(await screen.findByText('Hydranten')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('Aktualisieren re-reads the Divera pool', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: true } })
      return Promise.reject(new ApiError(503, 'off'))
    })
    getDiveraPool.mockResolvedValueOnce([{ id: '1' }]).mockResolvedValueOnce([{ id: '1' }, { id: '2' }])
    refreshDiveraPool.mockResolvedValue({ new: 1 })
    listPersonnel.mockResolvedValue([])
    listObjects.mockResolvedValue([])
    listReference.mockResolvedValue([])

    render(<DataView />)
    expect(await screen.findByText(/1 Alarm im Pool/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
    await waitFor(() => expect(refreshDiveraPool).toHaveBeenCalled())
    expect(await screen.findByText(/2 Alarme im Pool/)).toBeTruthy()
  })
})

describe('DataView — neutral states', () => {
  it('shows nicht-konfiguriert / empty states without crashing', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: false, traccarConfigured: false } })
      if (path === '/api/traccar/status') return Promise.resolve({ configured: false })
      return Promise.reject(new ApiError(503, 'off'))
    })
    listPersonnel.mockResolvedValue([])
    listObjects.mockResolvedValue([])
    listReference.mockResolvedValue([])

    render(<DataView />)

    expect(await screen.findByText('Keine Objekte hinterlegt.')).toBeTruthy()
    expect(await screen.findByText('Keine Referenzdaten eingespielt.')).toBeTruthy()
    // Two "nicht konfiguriert" badges (Divera + Traccar)
    await waitFor(() => expect(screen.getAllByText('nicht konfiguriert').length).toBeGreaterThanOrEqual(2))
  })

  it('survives an errored config + failed endpoints', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'boom'))
    listPersonnel.mockRejectedValue(new ApiError(500, 'boom'))
    listObjects.mockRejectedValue(new ApiError(500, 'boom'))
    listReference.mockRejectedValue(new ApiError(500, 'boom'))

    render(<DataView />)

    expect(await screen.findByText('Objekte konnten nicht geladen werden.')).toBeTruthy()
    expect(await screen.findByText('Daten konnten nicht geladen werden.')).toBeTruthy()
    // never throws — the integration status badges still render their labels
    expect(await screen.findByText('Divera')).toBeTruthy()
    expect(screen.getByText('Traccar (GPS)')).toBeTruthy()
  })
})
