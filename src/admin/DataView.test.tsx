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

import { AlarmProviderView, VehicleProviderView, ObjectsView, GeodataView } from './DataView'
import { appConfig } from '../config/appConfig'

/** Union of the Daten pages — they share no state, so mounting together is safe. */
function DataView() {
  return (
    <>
      <AlarmProviderView />
      <VehicleProviderView />
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

  // ⚠️ The reason this exists: both pages used to report «nicht konfiguriert» and offer nothing
  // but «Verbindung testen», which on an unconfigured instance fails by construction. The key
  // is entered on «Zugangsdaten», and until the shell passed a navigator down here these two
  // pages structurally could not say so.
  //
  // The Fahrzeugortung page still carries the bare button; the Alarmierung page absorbed it into
  // «Anbindung einrichten» (below), because two buttons to the same page on one screen is one
  // too many — so exactly ONE «Zugangsdaten öffnen» is the correct count now.
  it('offers the way out of «nicht konfiguriert» — the tracking page links to Zugangsdaten', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: false } })
      if (path === '/api/traccar/status') return Promise.resolve({ configured: false })
      return Promise.reject(new ApiError(503, 'off'))
    })
    const onNavigate = vi.fn()

    render(<><AlarmProviderView onNavigate={onNavigate} /><VehicleProviderView onNavigate={onNavigate} /></>)

    const buttons = await screen.findAllByRole('button', { name: 'Zugangsdaten öffnen' })
    expect(buttons.length).toBe(1)
    fireEvent.click(buttons[0])
    expect(onNavigate.mock.calls).toEqual([['zugaenge']])
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

// «Anbindung einrichten» — the page that reports «nicht konfiguriert» now also says how.
// What is pinned here is the three things that made the old page a dead end: the two paths are
// both named, the addresses a dispatch centre has to be given are copyable off THIS installation
// rather than a manual, manual creation is named as the valid baseline, and the card is gone once
// an alarm source works.
describe('DataView — die Alarmierungs-Seite richtet die Anbindung ein', () => {
  const C = appConfig.copy.admin.data

  const unconfigured = () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: false } })
      return Promise.reject(new ApiError(503, 'off'))
    })
  }

  it('names both paths and copies the REAL endpoints of this installation', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.setupTitle)).toBeTruthy()
    expect(C.setupCaption).toContain('manuell')
    expect(C.setupCaption.toLowerCase()).toContain('optional')
    expect(screen.getByText(C.setupCaption)).toBeTruthy()
    expect(screen.getByRole('radio', { name: new RegExp(C.pathDivera) })).toBeTruthy()

    // The webhook path is the one with addresses; both are the paths the backend actually
    // serves (api/alarms.py · POST /alarms, api/firehub.py · POST /firehub/webhook), and the
    // secret rides in the query string because FireHub cannot send headers.
    const chips = document.querySelectorAll('.adm-copychip code')
    const urls = Array.from(chips).map((c) => c.textContent)
    expect(urls).toEqual([
      `${window.location.origin}/api/alarms?secret=${C.secretPlaceholder}`,
      `${window.location.origin}/api/firehub/webhook?secret=${C.secretPlaceholder}`,
    ])
  })

  it('switches to the Divera instructions — which need no address at all', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(C.pathDivera) }))
    expect(screen.getByText(C.diveraNote)).toBeTruthy()
    expect(document.querySelectorAll('.adm-copychip').length).toBe(0)
  })

  it('leads to «Zugangsdaten», the only page that can set the secret', async () => {
    unconfigured()
    const onNavigate = vi.fn()
    render(<AlarmProviderView onNavigate={onNavigate} />)

    fireEvent.click(await screen.findByRole('button', { name: C.secretGo }))
    expect(onNavigate).toHaveBeenCalledWith('zugaenge')
  })

  // ⚠️ A setup card on a working station is clutter, and one that flashes up while the status is
  // still loading is worse — it accuses a configured instance of being unconfigured.
  it('is absent while the status loads, and stays absent once an alarm source works', async () => {
    let resolve!: (v: unknown) => void
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return new Promise((r) => { resolve = r })
      return Promise.reject(new ApiError(503, 'off'))
    })
    getDiveraPool.mockResolvedValue([])
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(screen.queryByText(C.setupTitle)).toBeNull()
    resolve({ integrations: { diveraConfigured: true } })
    expect(await screen.findByText(C.stateConnected)).toBeTruthy()
    expect(screen.queryByText(C.setupTitle)).toBeNull()
  })

  it('shows a configured webhook truthfully without probing the Divera pool', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') {
        return Promise.resolve({
          integrations: {
            alarms: { provider: 'webhook', configured: true, capabilities: ['generic-webhook', 'auto-open'] },
          },
        })
      }
      return Promise.reject(new ApiError(503, 'off'))
    })

    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText('Webhook')).toBeTruthy()
    expect(screen.getByText(C.stateConnected)).toBeTruthy()
    expect(screen.getByText(C.webhookActive)).toBeTruthy()
    expect(getDiveraPool).not.toHaveBeenCalled()
    expect(screen.queryByText(C.poolUnavailable)).toBeNull()
  })
})
