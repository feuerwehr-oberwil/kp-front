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
      { id: 'geo:hydranten', object_id: null, module: null, kind: 'geojson', title: 'Hydranten', source_type: 'export', source_note: 'BL', content_type: 'application/json', size_bytes: 2048, feature_count: 42, current_version: 1, updated_at: '2026-01-02T00:00:00Z' },
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

  // ⚠️ `/api/reference` is ONE registry for every global dataset: the Checklisten templates and
  // their diagram assets sit in it beside the map layers, and Kartenebenen used to list them all.
  it('Kartenebenen lists the geodata only — no Checklisten, no symbol pack', async () => {
    apiGet.mockRejectedValue(new ApiError(503, 'off'))
    listReference.mockResolvedValue([
      { id: 'geo:hydrant', object_id: null, module: null, kind: 'geojson', title: 'Hydranten', source_type: 'uploaded', source_note: null, content_type: 'application/geo+json', size_bytes: 10, feature_count: 42, current_version: 2, updated_at: '2026-01-02T00:00:00Z' },
      { id: 'checklists:el-taktik', object_id: null, module: null, kind: 'checklists', title: 'EL Taktik', source_type: 'uploaded', source_note: null, content_type: 'application/json', size_bytes: 10, feature_count: null, current_version: 1, updated_at: '2026-01-02T00:00:00Z' },
      { id: 'checklists:el-taktik:p12', object_id: null, module: null, kind: 'checklists', title: 'EL Taktik S. 12', source_type: 'uploaded', source_note: null, content_type: 'image/jpeg', size_bytes: 10, feature_count: null, current_version: 1, updated_at: '2026-01-02T00:00:00Z' },
      { id: 'symbols:tactical', object_id: null, module: null, kind: 'symbols', title: 'Taktische Zeichen', source_type: 'uploaded', source_note: null, content_type: 'application/json', size_bytes: 10, feature_count: null, current_version: 1, updated_at: '2026-01-02T00:00:00Z' },
    ])

    render(<GeodataView />)

    expect(await screen.findByText('Hydranten')).toBeTruthy()
    expect(screen.queryByText('EL Taktik')).toBeNull()
    expect(screen.queryByText('EL Taktik S. 12')).toBeNull()
    expect(screen.queryByText('Taktische Zeichen')).toBeNull()
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
  const C = appConfig.copy.admin.data

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
  // The Fahrzeugortung page carries it inside its «nicht eingerichtet»-Offer; the Alarmierung page
  // absorbed it into «Anbindung einrichten» (below), because two buttons to the same page on one
  // screen is one too many — so exactly ONE «Zugangsdaten öffnen» is the correct count now.
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
    // Never throws — both integration badges still render. They are LABEL-LESS since the house-
    // style pass (the page head names the integration), so what is pinned here is the state each
    // one reports when its own status endpoint is unreachable: «nicht verfügbar», not
    // «nicht konfiguriert» — nothing is known about the credentials.
    await waitFor(() => expect(screen.getAllByText(C.stateUnavailable).length).toBe(2))
  })
})

// «Anbindung einrichten» — the page that reports «nicht konfiguriert» now also says how.
// What is pinned here is the three things that made the old page a dead end: the two paths are
// both named, manual creation is named as the valid baseline, and the card is gone once an alarm
// source works.
//
// ⚠️ The two webhook ADDRESSES are no longer part of that: since 2026-09-10 every address this
// Wehr hands out is a row of «Links & Zugänge» (admin/LinksView), and this card printing them a
// third time was the duplication that page exists to end. So the card must carry NO copy chip —
// on either path.
describe('DataView — die Alarmierungs-Seite richtet die Anbindung ein', () => {
  const C = appConfig.copy.admin.data

  const unconfigured = () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: false } })
      return Promise.reject(new ApiError(503, 'off'))
    })
  }

  it('names both paths, and hands out no address of its own any more', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.setupTitle)).toBeTruthy()
    expect(C.setupCaption).toContain('manuell')
    expect(C.setupCaption.toLowerCase()).toContain('optional')
    expect(screen.getByText(C.setupCaption)).toBeTruthy()
    expect(screen.getByRole('radio', { name: new RegExp(C.pathDivera) })).toBeTruthy()

    // the webhook path used to print /api/alarms and /api/firehub/webhook here; both live on
    // «Links & Zugänge» now, so what this card still owes the reader is the secret's whereabouts
    expect(screen.getByText(C.secretTitle)).toBeTruthy()
    expect(document.querySelectorAll('.adm-copychip').length).toBe(0)
  })

  // ⚠️ This was the only class-less anchor in /admin: a bare <a> inheriting the global anchor
  // styling, and carrying a whole sentence as its link text where every other docs pointer in
  // /admin is a two-word chip («Doku», «Integrations-Doku»). Copy-agnostic on purpose — what is
  // pinned is the SHAPE (an `.adm-link` whose text is the document, with the sentence beside it),
  // not the words, which live in the copy catalogue.
  it('points at the field list as an .adm-link chip, not as a class-less sentence', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    await screen.findByText(C.setupTitle)
    const links = [...document.querySelectorAll('.adm-card a')]
    expect(links.length).toBe(1)
    const doc = links[0]
    expect(doc.classList.contains('adm-link')).toBe(true)
    expect(doc.getAttribute('href')).toContain('ALARM-INTEGRATIONS.md')
    // the caption around it carries the sentence; the anchor carries only the document
    expect((doc.textContent ?? '').length).toBeLessThan((doc.closest('p')?.textContent ?? '').length)
  })

  it('switches to the Divera instructions — which need no address at all', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(C.pathDivera) }))
    expect(screen.getByText(C.diveraNote)).toBeTruthy()
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

  it('offers no Verbindungstest at all while nothing is configured', async () => {
    unconfigured()
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.stateNotConfigured)).toBeTruthy()
    // A probe that can only fail teaches nothing – the setup card is the whole answer here.
    expect(screen.queryByRole('button', { name: C.testConnection })).toBeNull()
    expect(screen.getByRole('button', { name: C.secretGo })).toBeTruthy()
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

    // the badge carries the state only — «Webhook» was its label until the house-style pass
    expect(await screen.findByText(C.stateConnected)).toBeTruthy()
    expect(screen.getByText(C.webhookActive)).toBeTruthy()
    expect(getDiveraPool).not.toHaveBeenCalled()
    expect(screen.queryByText(C.poolUnavailable)).toBeNull()
  })
})

// ⚠️ «Verbindung testen» darf nur dort stehen, wo es etwas beantworten kann. Drei Zustände, nicht
// zwei: nicht eingerichtet (kein Test – der scheitert per Konstruktion und liest sich, als sei die
// App kaputt), eingerichtet aber nicht erreichbar (Test ist genau richtig – er IST der zweite
// Versuch) und Status selbst nicht abrufbar (dann ist über die Zugangsdaten nichts behauptet).
// One house style across /admin, and these are the three rules that were broken here:
// the control that ADDS sits in the card's head (not loose in its body), a page that shows
// two cards titles both of them, and a card carries at most one primary button.
describe('DataView — die Karten halten sich an die Hausordnung', () => {
  const C = appConfig.copy.admin.data
  const CO = appConfig.copy.admin.objects

  it('hängt «Objekt hinzufügen» in den Kopf der Karte, nicht in ihren Körper', async () => {
    listObjects.mockResolvedValue([])
    render(<ObjectsView title="Objekte & Pläne" />)

    expect(await screen.findByText(C.objectsNone)).toBeTruthy()
    const head = document.querySelector('.adm-card-head') as HTMLElement
    // the caller's title, the card's own action — and nothing loose in the body
    expect(head.querySelector('.adm-card-title')?.textContent).toContain('Objekte & Pläne')
    expect(head.querySelector('.adm-card-act button')?.textContent).toBe(CO.add)
    expect(document.querySelectorAll('.adm-card-body > .adm-brand-row')).toHaveLength(0)
  })

  it('betitelt die Status-Karte genau dann, wenn die Einrichtungs-Karte daneben steht', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: false } })
      return Promise.reject(new ApiError(503, 'off'))
    })
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    // two cards on screen → both titled
    expect(await screen.findByText(C.setupTitle)).toBeTruthy()
    expect(screen.getByText(C.statusTitle)).toBeTruthy()

    cleanup()
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: true } })
      return Promise.reject(new ApiError(503, 'off'))
    })
    getDiveraPool.mockResolvedValue([])
    render(<AlarmProviderView onNavigate={vi.fn()} />)

    // one card → it leans on the page head instead
    expect(await screen.findByText(C.stateConnected)).toBeTruthy()
    expect(screen.queryByText(C.statusTitle)).toBeNull()
  })
})

describe('DataView — kein Verbindungstest ohne Anbindung', () => {
  const C = appConfig.copy.admin.data

  it('Fahrzeugortung: nicht eingerichtet – kein Test, dafür der Weg zu den Zugangsdaten', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/traccar/status') return Promise.resolve({ configured: false })
      return Promise.reject(new ApiError(503, 'off'))
    })
    const onNavigate = vi.fn()

    render(<VehicleProviderView onNavigate={onNavigate} />)

    expect(await screen.findByText(C.stateNotConfigured)).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.testConnection })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: C.openCredentials }))
    expect(onNavigate.mock.calls).toEqual([['zugaenge']])
  })

  it('Fahrzeugortung: eingerichtet, aber nicht erreichbar – der Test bleibt', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/traccar/status') return Promise.resolve({ configured: true, host: 'gps.example.ch' })
      return Promise.reject(new ApiError(502, 'upstream down'))
    })

    render(<VehicleProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.positionsUnavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: C.testConnection })).toBeTruthy()
    expect(screen.queryByRole('button', { name: C.openCredentials })).toBeNull()
  })

  it('Fahrzeugortung: Status nicht abrufbar – «nicht verfügbar», Test als zweiter Versuch', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'boom'))

    render(<VehicleProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.stateUnavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: C.testConnection })).toBeTruthy()
    // Nichts sagt, dass die Zugangsdaten fehlen – also wird auch nicht dorthin geschickt.
    expect(screen.queryByRole('button', { name: C.openCredentials })).toBeNull()
  })

  it('Alarmierung: eingerichtet, aber Pool nicht erreichbar – der Test bleibt', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/config') return Promise.resolve({ integrations: { diveraConfigured: true } })
      return Promise.reject(new ApiError(502, 'upstream down'))
    })
    getDiveraPool.mockRejectedValue(new ApiError(502, 'upstream down'))

    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.poolUnavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: C.testConnection })).toBeTruthy()
    expect(screen.queryByText(C.setupTitle)).toBeNull()
  })

  it('Alarmierung: /api/config nicht abrufbar – keine Einrichtungs-Karte, aber ein Test', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'boom'))

    render(<AlarmProviderView onNavigate={vi.fn()} />)

    expect(await screen.findByText(C.stateUnavailable)).toBeTruthy()
    // Ein nicht erreichbarer Server hat nicht gesagt, dass hier nie etwas eingerichtet wurde.
    expect(screen.queryByText(C.setupTitle)).toBeNull()
    expect(screen.getByRole('button', { name: C.testConnection })).toBeTruthy()
  })
})
