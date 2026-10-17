// @vitest-environment jsdom
// «Karte & Objekte» end to end on the surface, with the map as a prop recorder (like the
// IncidentWorkspace harness): an object opens the panel, «Objektbesuch» hands over at the C1
// address, a pin becomes a «Meldung» at a place, Messen offers NO «Als Linie übernehmen», and
// nothing the viewer does writes anything but its own view keys. Synthetic Musterdorf data.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { StationObjects } from '../../lib/api/stationReference'
import type { LngLat } from '../../types'

const rec = vi.hoisted(() => ({ map: [] as Record<string, unknown>[], phone: false }))
const lastMap = () => rec.map[rec.map.length - 1] as { onMapClick: (c: LngLat) => void; measurePoints: LngLat[]; children?: ReactNode }

const CATALOGUE: StationObjects = {
  generatedAt: '2026-10-16T10:00:00Z',
  objects: [
    { id: 'schloss', name: 'Schloss Musterdorf', kind: 'einsatzobjekt', address: 'Schlossgasse 9, 9999 Musterdorf', lat: 47.523773, lng: 7.570188,
      aliases: ['Wasserschloss'], plans: [{ id: 'plan:schloss:modul1', module: 'modul1', code: '1', title: 'Modul 1 · Übersicht', pages: 2, georef: false, version: 1 }],
      floors: [], egid: null, footprint: null, lastVisit: null, measures: 'Zufahrt nur über Schlossgasse', measuresSource: 'Modul 1' },
    { id: 'depot', name: 'Schlüsseldepot Schloss', kind: 'depot', address: 'Schlossgasse 9', lat: 47.52402, lng: 7.56985,
      aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null },
  ],
}

vi.mock('../../lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/auth')>()
  const value = { user: { id: 'u1', username: 'fu', display_name: 'FU Test', role: 'editor' as const, color: null, last_login: null }, loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout: () => Promise.resolve() }
  return { ...mod, useAuth: () => value }
})
vi.mock('../../lib/useSymbols', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/useSymbols')>()), useSymbols: () => ({ ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} }) }))
vi.mock('../MapView', () => ({
  MapView: (p: Record<string, unknown> & { children?: ReactNode }) => { rec.map.push(p); return <div data-testid="mapview">{p.children}</div> },
}))
vi.mock('react-map-gl/maplibre', () => ({ Marker: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../../lib/api/stationReference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/stationReference')>()),
  loadStationObjects: async () => ({ value: CATALOGUE, source: 'network' as const }),
  loadStationBuilding: async () => null,
}))
vi.mock('../../objectVisits/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../objectVisits/api')>()), listVisits: async () => [] }))
vi.mock('../../lib/api/geo', () => ({
  geocodeSearch: async () => [],
  geocodeReverse: async (lat: number, lng: number) => ({ label: 'Starenstrasse 19, 9999 Musterdorf', lat, lng }),
}))
vi.mock('../../lib/deploymentConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deploymentConfig')>()),
  objectVisitsConfig: () => ({ enabled: true, captureRoles: ['editor', 'el'] }),
}))
vi.mock('../../lib/useWeather', () => ({ useWeather: () => ({ data: null, error: null }) }))
vi.mock('../../lib/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/ui')>()), toast: vi.fn() }))
vi.mock('../../lib/useVehicleLayer', () => ({ useVehicleLayer: () => ({ liveVehicles: [] }) }))
vi.mock('../PdfScroller', () => ({ PdfScroller: ({ url }: { url: string }) => <div data-testid="pdf">{url}</div> }))

import KarteApp, { type KarteAppProps } from './KarteApp'
import { toast } from '../../lib/ui'
import { appConfig } from '../../config/appConfig'

class RO { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  window.matchMedia = ((q: string) => ({
    matches: rec.phone, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  rec.map.length = 0
  rec.phone = false
  localStorage.clear(); sessionStorage.clear()
  window.history.replaceState(null, '', '/karte')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(toast).mockClear() })

const mount = (over: Partial<KarteAppProps> = {}) => {
  const onOpenVisits = vi.fn()
  // the launcher's content as App hands it in: a row that closes the sheet, like «Manueller Einsatz»
  const launcherRow = vi.fn()
  const einsaetze = {
    badge: 0,
    render: (close: () => void) => <button type="button" onClick={() => { launcherRow(); close() }}>Manueller Einsatz</button>,
  }
  render(<KarteApp einsaetze={einsaetze} onOpenVisits={onOpenVisits} running={[]} onOpenIncident={vi.fn()} {...over} />)
  return { onOpenVisits, launcherRow }
}

describe('KarteApp', () => {
  it('opens an object from its tag and hands a visit over at the contract address', async () => {
    const { onOpenVisits } = mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(screen.getByText('Zufahrt nur über Schlossgasse')).toBeTruthy()
    // the address follows the selection, without a history entry
    await waitFor(() => expect(window.location.search).toBe('?objekt=schloss'))
    fireEvent.click(screen.getByRole('button', { name: /Objektbesuch/ }))
    expect(onOpenVisits).toHaveBeenCalledWith('/besuche/neu?object=schloss&from=karte')
  })

  it('measures from an object without offering to keep it, and stores nothing of it', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Messen ab hier/ }))
    await waitFor(() => expect(lastMap().measurePoints).toHaveLength(1))
    act(() => lastMap().onMapClick([7.5708, 47.52455]))
    await waitFor(() => expect(lastMap().measurePoints).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /übernehmen/ })).toBeNull()
    // …and no line saying so either (owner-6, 17.10.2026): nothing on this surface is ever saved
    expect(screen.queryByText(/Nur zum Nachschauen/)).toBeNull()
    // only the viewer's own view keys were written — no workspace, no drawing, no measure
    expect(Object.keys(sessionStorage)).toEqual(['kp.karte.view'])
    expect(sessionStorage.getItem('kp.karte.view')).not.toMatch(/7\.5708/)
    expect(Object.keys(localStorage).filter((k) => !k.startsWith('kp.karte') && k !== 'kp.layers.karte')).toEqual([])
  })

  it('drops a pin with the tool and files a Meldung at that place', async () => {
    const { onOpenVisits } = mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Punkt setzen' }))
    act(() => lastMap().onMapClick([7.57175, 47.52015]))
    expect(await screen.findByText('bei Starenstrasse 19')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Meldung erfassen/ }))
    const href = onOpenVisits.mock.calls[0][0] as string
    const q = new URLSearchParams(href.split('?')[1])
    expect(href.startsWith('/besuche/neu?')).toBe(true)
    expect(q.get('label')).toBe('bei Starenstrasse 19')
    expect(q.get('address')).toBe('Starenstrasse 19, 9999 Musterdorf')
    expect(q.get('from')).toBe('karte')
  })

  it('searches the catalogue on the device, objects with plans first', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.change(screen.getByPlaceholderText('Adresse oder Objekt suchen …'), { target: { value: 'schloss' } })
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toMatch(/Schloss Musterdorf/)
    expect(options[1].textContent).toMatch(/Schlüsseldepot Schloss/)
  })

  it('opens a deep link on its object', async () => {
    window.history.replaceState(null, '', '/karte?objekt=depot')
    mount()
    expect(await screen.findByRole('heading', { name: 'Schlüsseldepot Schloss' })).toBeTruthy()
    expect(screen.getByText('Schlüsseldepot ohne Pläne. Kontrolliert über die Objektbesuche.')).toBeTruthy()
  })

  // home (variant B): the old launcher card is the «Einsätze ▾» sheet — App's content, opened here
  it('opens the launcher content as the «Einsätze» sheet and shuts it when a row acts', async () => {
    const { launcherRow } = mount({ einsaetze: { badge: 2, render: (close) => <button type="button" onClick={() => { close() }}>Manueller Einsatz</button> } })
    void launcherRow
    const button = screen.getByRole('button', { name: /Einsätze/ })
    expect(screen.getByLabelText('2 offen').textContent).toBe('2')
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Einsätze' })).getByRole('button', { name: 'Manueller Einsatz' }))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    // Escape and a press outside close it too
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    fireEvent.click(button)
    fireEvent.pointerDown(screen.getByTestId('mapview'))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
  })

  // the app menu's offline row on home is the viewer's own «Auf diesem Gerät» (panels/AppMenuRows)
  it('hands the sheet a door to «Auf diesem Gerät», which shuts the sheet and opens it', async () => {
    mount({ einsaetze: { badge: 0, render: (_close, onDevice) => <button type="button" onClick={onDevice}>Gerät</button> } })
    fireEvent.click(screen.getByRole('button', { name: /Einsätze/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Einsätze' })).getByRole('button', { name: 'Gerät' }))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: appConfig.copy.karte.device.title })).toBeTruthy()
  })

  it('keeps no badge with nothing running and no alarm to take', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    expect(screen.queryByLabelText(/offen$/)).toBeNull()
  })

  it('comes back from an Einsatz where it was left — object, plan, tool — and says so once', async () => {
    sessionStorage.setItem('kp.karte.view', JSON.stringify({
      center: [7.570188, 47.523773], zoom: 18, bearing: 0, objectId: 'schloss', surface: { plan: 'plan:schloss:modul1' },
      tool: 'layers', label: 'Schloss Musterdorf · Modul 1',
    }))
    window.history.replaceState(null, '', '/karte')
    mount({ announceReturn: true })
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalled())
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Wieder bei Schloss Musterdorf · Modul 1', { icon: 'check' })
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)
    // the tool that was open is open again, and the label the Einsatz menu reads is kept
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('kp.karte.view')!)).toMatchObject({
      objectId: 'schloss', surface: { plan: 'plan:schloss:modul1' }, tool: 'layers', label: 'Schloss Musterdorf · Modul 1',
    }))
  })

  it('says nothing on a plain start (home), only after an Einsatz', async () => {
    window.history.replaceState(null, '', '/')
    sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.57, 47.52], zoom: 16, bearing: 0, objectId: 'schloss', surface: 'karte', label: 'Schloss Musterdorf' }))
    mount()
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
    // home lives at `/`: the selection does not move it to /karte
    expect(window.location.pathname).toBe('/')
  })

  // owner-4 (17.10.2026): on a phone the plans are rows in the object's sheet — the bar has no
  // «Pläne» tab — and an open plan goes back to the map with its «Zur Karte» chip
  it('on a phone: no Pläne tab, the plan opens from the sheet and goes back to it', async () => {
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    expect(within(nav).queryByRole('button', { name: /Pläne/ })).toBeNull()
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Karte', 'Messen', 'Gefahrgut', 'Ebenen'])
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Modul 1 · Übersicht/ }))
    expect(await screen.findByTestId('pdf')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Schloss Musterdorf' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Zur Karte/ }))
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(screen.queryByTestId('pdf')).toBeNull()
  })
})
